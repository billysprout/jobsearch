// scrape.mjs — daily job-scrape orchestrator.
// Runs on the Windows HOST (not in the sandbox). Writes results into the
// sandbox workspace volume via a tar-pipe through a one-off alpine container.
//
// Usage:
//   node scrape.mjs --once                   # full run (fetch + colibri + write to volume)
//   node scrape.mjs --once --dry-run          # fetch + colibri, output to stdout, no volume write, no state mutation
//   node scrape.mjs --once --no-colibri       # skip colibri, use heuristic scores only
//   node scrape.mjs --once --limit 5          # cap to 5 postings after pre-filter
//   node scrape.mjs --once --dry-run --limit 5 --no-colibri  # fastest dev mode
//
// Pipeline (see also README / SECURITY-REVIEW.md discussion in the parent repo):
//   1. fetch all enabled sources
//   2. keyword pre-filter (word-boundary matching, see keywords.mjs)
//   3. drop postings already in state/seen.json or already queued in
//      state/pending-colibri.json (dedupe happens AFTER the filter now — a
//      posting that never matched any track is never marked seen, so
//      improving the keyword list later can still catch it; only postings
//      that are genuinely about to be shown get burned from future
//      consideration)
//   4. sort candidates so curated ATS sources (greenhouse/lever — companies
//      we deliberately chose to track) rank ahead of generic job boards
//      before applying --limit, so the cap doesn't get exhausted by noisy
//      high-volume sources before it ever reaches the curated ones. Anything
//      still sitting in the pending-colibri queue from a prior offline run
//      goes first, ahead of newly-fetched candidates.
//   5. rank via colibri and, for every chunk as soon as it's ranked (NOT
//      batched to the end — colibri-backed runs can take hours and the
//      scheduled task hard-kills on timeout, see register-task.ps1):
//        a. on success: mark that chunk's source postings seen, drop them
//           from the pending-colibri queue, and merge into today's
//           accumulated digest (state/digest-<date>.json) so a second run
//           the same day supplements rather than silently overwrites the
//           first run's results, and so a killed run leaves behind
//           everything ranked up to that point; render + write the digest
//           to the workspace volume
//        b. on failure (colibri offline/erroring): do NOT mark seen and do
//           NOT heuristic-score it into the digest — add the posting to
//           state/pending-colibri.json instead, so the next run retries it
//           for real (see colibri.mjs). --no-colibri and the
//           heuristicSkipThreshold pre-gate are unaffected: those are
//           deliberate heuristic scoring, not an outage, and mark seen as
//           usual.
//   6. optional cover-letter drafting (--drafts), on top of the
//      already-published digest
//
// --dry-run skips all state/volume writes entirely (no seen.json write, no
// digest-state write, no volume write, no drafting) — side-effect-free.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { fetchAll } from "./sources.mjs";
import { rankPostings, heuristicRankings } from "./colibri.mjs";
import { firstTrackMatch, bestTrackScore } from "./keywords.mjs";
import { draftTopN } from "./draft.mjs";
import { writeFilesToVolume } from "./volume-writer.mjs";
import { loadConfig } from "./config.mjs";

// --- CLI ---
const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const DRY_RUN_FLAG = args.includes("--dry-run");
const NO_COLIBRI = args.includes("--no-colibri");
// --profile <name>: overlays configs/<name>.json on configs/base.json.
// Precedence: this flag > JOBSCRAPE_PROFILE env > "production".
const profileIdx = args.indexOf("--profile");
const PROFILE = profileIdx !== -1 ? args[profileIdx + 1] : undefined;
// Numeric flags parse early but resolve against config defaults below (a
// flag value always wins; an absent flag takes the config value).
const limitIdx = args.indexOf("--limit");
const LIMIT_FLAG = limitIdx !== -1 ? (Number(args[limitIdx + 1]) || undefined) : undefined;
// --drafts [N]: opt-in cover-letter drafting for the top N postings by score
// (config default if the flag is present with no number). Needs colibri and
// jobscrape/profile.md — see draft.mjs. Off by default: it's extra colibri
// calls on top of ranking, and colibri throughput is already the reason
// --limit is capped at 10 in production (see register-task.ps1).
const draftsIdx = args.indexOf("--drafts");
const HAS_DRAFTS = draftsIdx !== -1;
const DRAFTS_VALUE = HAS_DRAFTS ? Number(args[draftsIdx + 1]) : 0;

if (!ONCE) {
  console.error("Usage: node scrape.mjs --once [--profile NAME] [--dry-run] [--limit N] [--no-colibri] [--drafts [N]]");
  process.exit(1);
}

// --- Config ---
const config = loadConfig({ profile: PROFILE });
const DRY_RUN = DRY_RUN_FLAG || config.run.dryRun;
const LIMIT = LIMIT_FLAG ?? config.selection.limit;
const DRAFTS = HAS_DRAFTS ? (DRAFTS_VALUE || config.run.draftDefaultCount) : 0;
// JOBSCRAPE_STATE_DIR: test seam — the parity test runs against a frozen
// state snapshot so golden diffs measure code drift, not live seen.json
// growth. Production runs never set it.
const STATE_DIR = process.env.JOBSCRAPE_STATE_DIR
  ? resolve(process.env.JOBSCRAPE_STATE_DIR)
  : resolve(__dirname, "state");
const STAGING_DIR = resolve(__dirname, "staging");

// Curated ATS sources (companies we deliberately picked) rank ahead of
// generic job boards when the --limit cap is applied.
const SOURCE_PRIORITY = { greenhouse: 0, lever: 0, workable: 0, ashby: 0, remotive: 1, hn: 1, remoteok: 2, wwr: 2 };
function sourcePriority(source) {
  return SOURCE_PRIORITY[source] ?? 3;
}

// Round-robin across companies within each priority tier so no single
// company (e.g. Riot with 129+ eligible postings) can consume all --limit
// slots before other curated companies or generic boards get a look.
// Before this fix the stable sort preserved fetch order within a tier,
// meaning the first-listed greenhouse company in config got every slot
// every day.
function interleaveByCompany(postings, perCompanyMax) {
  const tiers = {};
  for (const p of postings) {
    const pri = sourcePriority(p.source);
    if (!tiers[pri]) tiers[pri] = new Map();
    const key = `${p.source}:${p.company}`;
    if (!tiers[pri].has(key)) tiers[pri].set(key, []);
    tiers[pri].get(key).push(p);
  }
  const result = [];
  for (const pri of Object.keys(tiers).sort((a, b) => a - b)) {
    const queues = [...tiers[pri].values()];
    const maxLen = Math.min(
      Math.max(...queues.map(q => q.length)),
      perCompanyMax,
    );
    for (let i = 0; i < maxLen; i++) {
      for (const q of queues) {
        if (i < q.length) result.push(q[i]);
      }
    }
  }
  return result;
}

// --- State (seen.json) ---
const STATE_FILE = join(STATE_DIR, "seen.json");

/** @type {Set<string>} */
let seen;
if (existsSync(STATE_FILE)) {
  seen = new Set(JSON.parse(readFileSync(STATE_FILE, "utf8")));
} else {
  seen = new Set();
}
console.error(`[state] ${seen.size} previously seen postings`);

function saveSeen() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify([...seen], null, 0));
}

// --- Pending-colibri queue: postings that matched a track but couldn't be
// ranked because colibri was offline. They are deliberately NOT marked seen
// and NOT written to the digest with a heuristic score — they're carried
// forward run to run (oldest first) until colibri is back to actually score
// them, so a colibri outage delays a posting's appearance rather than
// permanently degrading it to a keyword guess.
const PENDING_FILE = join(STATE_DIR, "pending-colibri.json");

/** @type {Map<string, object>} keyed by `${source}:${id}` */
let pendingQueue;
if (existsSync(PENDING_FILE)) {
  const list = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  pendingQueue = new Map(list.map(p => [`${p.source}:${p.id}`, p]));
} else {
  pendingQueue = new Map();
}
console.error(`[state] ${pendingQueue.size} posting(s) pending colibri from a prior offline run`);

function savePendingQueue() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify([...pendingQueue.values()], null, 0));
}

// --- Today's accumulated digest state (fixes same-day overwrite) ---
function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function digestStateFile(stamp) {
  return join(STATE_DIR, `digest-${stamp}.json`);
}

function loadTodayRankings(stamp) {
  const f = digestStateFile(stamp);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    console.error(`[digest-state] failed to parse ${f}, starting fresh`);
    return [];
  }
}

function saveTodayRankings(stamp, rankings) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(digestStateFile(stamp), JSON.stringify(rankings, null, 0));
}

// Light housekeeping: prune digest-state files older than 7 days so
// state/ doesn't grow forever. Best-effort — never fatal.
function pruneOldDigestState() {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(STATE_DIR)) {
      const m = name.match(/^digest-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const fileTime = Date.parse(m[1] + "T00:00:00Z");
      if (fileTime < cutoff) unlinkSync(join(STATE_DIR, name));
    }
  } catch {
    // state dir may not exist yet — fine
  }
}

// --- Debug snapshots: what the pipeline saw at each stage of the most
// recent run, so "why didn't X show up" can be answered by reading a file
// instead of writing a throwaway inspection script (as happened during the
// 2026-08-24 pipeline audit). Overwritten every run — these are a "what
// happened last time" snapshot, not accumulated history. Written on every
// run including --dry-run: unlike seen.json/digest state, these don't feed
// back into future pipeline decisions, so writing them doesn't compromise
// dry-run's "no effect on future behavior" guarantee.
function writeSnapshot(name, postings) {
  mkdirSync(STATE_DIR, { recursive: true });
  const rows = postings.map(p => ({
    source: p.source, id: p.id, company: p.company, title: p.title, url: p.url,
    matchedTrack: p._matchedTrack, matchedKeyword: p._matchedKeyword,
  }));
  writeFileSync(join(STATE_DIR, `last-run-${name}.json`), JSON.stringify(rows, null, 2));
}

// --- Pre-filter (word-boundary keyword matching, see keywords.mjs) ---
function preFilter(postings) {
  const matched = [];
  let unmatched = 0;

  for (const p of postings) {
    const text = `${p.title} ${p.company} ${p.bodyText}`.toLowerCase();
    const hit = firstTrackMatch(text, config.tracks);
    if (hit) {
      // Stashed for the debug snapshot below — lets you see *why* something
      // matched without re-running the filter logic by hand.
      p._matchedTrack = hit.track;
      p._matchedKeyword = hit.keyword;
      matched.push(p);
    } else {
      unmatched++;
    }
  }
  console.error(`[filter] ${matched.length} matched, ${unmatched} skipped (no keyword overlap)`);
  return matched;
}

// --- Digest renderer ---
function renderDigest(dateStr, ranked, colibriOnline) {
  const trackLabels = {};
  for (const [key, t] of Object.entries(config.tracks)) trackLabels[key] = t.label;

  const byTrack = { esports: [], "it-devops": [], "producer-pm": [], none: [] };
  for (const r of ranked) {
    (byTrack[r.track] || byTrack.none).push(r);
  }

  let md = `# Job Digest — ${dateStr}\n\n`;
  if (colibriOnline) {
    md += `Ranked by **colibri (glm-5.2-colibri)**. ${ranked.length} postings scored.\n\n`;
  } else {
    md += `> **colibri: OFFLINE (heuristic scores)** -- keyword-based only.\n\n`;
  }

  for (const [track, items] of Object.entries(byTrack)) {
    if (!items.length) continue;
    items.sort((a, b) => b.score - a.score);
    const label = trackLabels[track] || track;
    md += `## ${label} (${items.length})\n\n`;
    md += `| Score | Company | Title | Location | Fit |\n`;
    md += `|------:|---------|-------|----------|-----|\n`;
    for (const r of items) {
      const posting = r._posting;
      md += `| ${r.score} | ${esc(posting.company)} | [${esc(posting.title)}](${posting.url}) | ${esc(posting.location)} | ${esc(r.one_line)} |\n`;
    }
    md += `\n`;
  }

  return md;
}

// Compact machine-readable summary alongside the markdown digest — top N per
// track, written to digest/<stamp>-summary.json. Purpose-built for
// digest-notify.mjs (WhatsApp push) so it doesn't have to parse the markdown
// table; kept separate from state/digest-<date>.json, which is jobscrape's
// own accumulation state and isn't written to the workspace volume at all.
function renderSummaryJson(ranked, topNPerTrack = 5) {
  const byTrack = {};
  for (const r of ranked) {
    if (r.track === "none") continue;
    (byTrack[r.track] ||= []).push(r);
  }
  const out = [];
  for (const items of Object.values(byTrack)) {
    items.sort((a, b) => b.score - a.score);
    for (const r of items.slice(0, topNPerTrack)) {
      out.push({
        id: r.id,
        track: r.track,
        score: r.score,
        company: r._posting.company,
        title: r._posting.title,
        url: r._posting.url,
        one_line: r.one_line,
      });
    }
  }
  return out;
}

function renderCard(r) {
  const p = r._posting;
  return `# ${p.title}\n\n`
    + `- **Company**: ${p.company}\n`
    + `- **Source**: ${p.source}\n`
    + `- **Location**: ${p.location || "N/A"}\n`
    + `- **Salary**: ${p.salary || "N/A"}\n`
    + `- **URL**: ${p.url}\n`
    + `- **Score**: ${r.score}/100 (${r.track})\n`
    + `- **Fit**: ${r.one_line}\n\n`
    + `## Fit Notes\n${r.fit_notes}\n\n`
    + `## Job Description (excerpt)\n${(p.bodyText || "").substring(0, 2000)}\n`;
}

const AGENT_README = [
  "# jobs/",
  "",
  "This directory contains daily job digests scraped from the host machine.",
  "Read the latest digest in digest/ for ranked postings, or individual cards in postings/.",
  "",
  "Tracks: Esports/Gaming Ops, IT/DevOps/Sysadmin, Producer/PM.",
  "",
  "digest/<date>-summary.json is a compact top-N-per-track version of the same",
  "date's digest, consumed by digest-notify.mjs for the WhatsApp push.",
  "",
  "postings/<id>-draft.md — a draft cover letter, only present when the scrape",
  "was run with --drafts. Read it, edit it, send it yourself; nothing here is",
  "submitted anywhere automatically.",
  "",
  "Files are regenerated daily. Stale digests are safe to delete.",
].join("\n");

function esc(s) {
  return (s || "").replace(/\|/g, "\\|").replace(/\n/g, " ").substring(0, 60);
}

// --- Workspace writer (tar-pipe into docker volume, see volume-writer.mjs) ---
async function writeToVolume(digestMd, cards, stamp, summaryJson, drafts) {
  const files = [
    { relPath: "README.md", content: AGENT_README },
    { relPath: `digest/${stamp}.md`, content: digestMd },
    { relPath: `digest/${stamp}-summary.json`, content: JSON.stringify(summaryJson, null, 2) },
  ];
  for (const card of cards) {
    files.push({ relPath: `postings/${card.id}.md`, content: card.content });
  }
  for (const draft of drafts) {
    files.push({ relPath: `postings/${draft.id}-draft.md`, content: draft.content });
    if (draft.pdfBuffer) {
      files.push({ relPath: `postings/${draft.id}-draft.pdf`, content: draft.pdfBuffer });
    }
  }

  await writeFilesToVolume({
    volume: config.workspaceVolume,
    targetPath: config.workspacePath,
    stagingDir: STAGING_DIR,
    files,
  });
}

// --- Main ---
async function main() {
  console.error(`[main] === jobscrape ${new Date().toISOString()} ===`);
  console.error(`[main] dry-run=${DRY_RUN}  no-colibri=${NO_COLIBRI}  limit=${LIMIT}`);

  // 1. Fetch all sources
  console.error("[main] step 1/6: fetching sources...");
  const allPostings = await fetchAll(config);

  // 2. Keyword pre-filter (BEFORE dedupe now — see header comment)
  console.error("[main] step 2/6: keyword pre-filter...");
  const matched = preFilter(allPostings);
  // PRE-seen-filter snapshot: everything that matched a track keyword this
  // run, including postings already seen in a prior run. Answers "did this
  // posting even pass the keyword filter at all?" — see jobscrape/state/last-run-matched.json
  writeSnapshot("matched", matched);

  // 3. Drop already-seen (only matched postings ever touch `seen`) and
  // anything already sitting in the pending-colibri queue (it'll be
  // re-included below without going through the source fetch again).
  console.error("[main] step 3/6: deduping against seen state...");
  const freshMatched = matched.filter(p => !seen.has(`${p.source}:${p.id}`) && !pendingQueue.has(`${p.source}:${p.id}`));
  console.error(`[dedupe] ${freshMatched.length} new-and-relevant, ${matched.length - freshMatched.length} already seen or pending`);
  // POST-seen-filter snapshot: the actual eligible pool this run drew
  // candidates from, before source-priority sorting and --limit capping.
  // Answers "why wasn't this scored" for anything NOT in this file despite
  // being in last-run-matched.json — it was filtered here, as already-seen.
  // See jobscrape/state/last-run-eligible.json
  writeSnapshot("eligible", freshMatched);

  if (!freshMatched.length && !pendingQueue.size) {
    console.error("[main] nothing new to rank -- done");
    return;
  }

  // 4. Sort by source priority (curated ATS first), then cap. Pending
  // postings (carried over from a prior colibri outage) go first — they're
  // the oldest work in the queue and get first claim on this run's budget.
  console.error("[main] step 4/6: prioritizing + capping...");
  const sorted = interleaveByCompany(freshMatched, config.selection.perCompanyMax);
  const combinedPool = [...pendingQueue.values(), ...sorted];
  const candidates = combinedPool.slice(0, LIMIT);
  console.error(`[main] ${candidates.length} candidates after priority sort + cap (${pendingQueue.size} pending + ${freshMatched.length} new-eligible)`);

  // 5. Rank via colibri (or heuristic), with a heuristic pre-gate for
  // high-confidence matches. Colibri throughput is the binding constraint on
  // --limit (see register-task.ps1), so postings the keyword scorer is
  // already confident about skip the colibri call entirely, reserving that
  // budget for genuinely ambiguous candidates.
  //
  // Streaming: a colibri-backed run can take hours and the Windows
  // Scheduled Task that runs this hard-kills the process on timeout (see
  // register-task.ps1's ExecutionTimeLimit). Rather than accumulating
  // rankings in memory and writing the digest once at the very end, every
  // ranked chunk is persisted (seen.json, state/digest-<date>.json) and
  // published to the workspace volume as soon as it's ready — a kill at any
  // point loses at most the one chunk in flight, not the whole run.
  console.error("[main] step 5/6: ranking...");
  const postingMap = new Map(candidates.map(p => [p.id, p]));
  const stamp = todayStamp();
  let allTodayRankings = DRY_RUN ? [] : loadTodayRankings(stamp);
  let colibriOnlineSoFar = true;
  let latestDigestMd = "";
  let latestSummaryJson = [];
  let rankings = [];

  function attachPosting(list) {
    for (const r of list) {
      r._posting = postingMap.get(r.id) || { id: r.id, source: "?", company: "?", title: "?", location: "", salary: "", url: "", bodyText: "" };
    }
    return list;
  }

  // Marks `sourcePostings` seen, merges `newRankings` into today's
  // accumulated state, re-renders, and writes to the workspace volume — so
  // the on-disk digest always reflects everything ranked so far, not just
  // what was ranked by the time the whole run finished. `sourcePostings` may
  // be `[]` for a ranking that was already marked seen as part of an earlier
  // chunk (see the missing-id fallback below).
  async function persistAndPublish(newRankings, sourcePostings) {
    if (DRY_RUN || !newRankings.length) return;
    for (const p of sourcePostings) seen.add(`${p.source}:${p.id}`);
    if (sourcePostings.length) saveSeen();

    allTodayRankings.push(...newRankings);
    saveTodayRankings(stamp, allTodayRankings);

    latestDigestMd = renderDigest(stamp, allTodayRankings, colibriOnlineSoFar);
    latestSummaryJson = renderSummaryJson(allTodayRankings);
    const cards = newRankings.map(r => ({ id: r.id, content: renderCard(r) }));
    await writeToVolume(latestDigestMd, cards, stamp, latestSummaryJson, []);
    console.error(`[main] streamed ${newRankings.length} new ranking(s) to digest (${allTodayRankings.length} total today)`);
  }

  // Postings deferred to the pending-colibri queue this run (colibri
  // offline/erroring) — excluded from the "colibri missed" fallback below,
  // since those are genuinely retried next run, not a malformed-response fluke.
  const deferredIds = new Set();

  if (NO_COLIBRI) {
    // Explicit opt-out, not an outage — score everything heuristically now,
    // including anything that was sitting in the pending queue.
    rankings = attachPosting(heuristicRankings(candidates, config.tracks));
    colibriOnlineSoFar = false;
    await persistAndPublish(rankings, candidates);
    if (!DRY_RUN) {
      for (const p of candidates) pendingQueue.delete(`${p.source}:${p.id}`);
      savePendingQueue();
    }
  } else {
    const skipThreshold = config.colibri.heuristicSkipThreshold;
    let toRank = candidates;
    let preGated = [];

    if (typeof skipThreshold === "number") {
      const scored = candidates.map(p => ({
        posting: p,
        ...bestTrackScore(`${p.title} ${p.company} ${p.bodyText}`.toLowerCase(), config.tracks),
      }));
      preGated = scored.filter(s => s.score >= skipThreshold).map(s => s.posting);
      toRank = scored.filter(s => s.score < skipThreshold).map(s => s.posting);
      if (preGated.length) {
        console.error(`[main] ${preGated.length} candidate(s) skip colibri (heuristic score >= ${skipThreshold}), ${toRank.length} sent to colibri`);
      }
    }

    if (preGated.length) {
      const preGatedRankings = attachPosting(heuristicRankings(preGated, config.tracks).map(r => ({
        ...r,
        fit_notes: `${r.fit_notes} — skipped colibri, high-confidence keyword match (>= ${skipThreshold})`,
      })));
      rankings.push(...preGatedRankings);
      await persistAndPublish(preGatedRankings, preGated);
      if (!DRY_RUN) {
        for (const p of preGated) pendingQueue.delete(`${p.source}:${p.id}`);
        savePendingQueue();
      }
    }

    await rankPostings(config, toRank, async (parsed, chunk, { colibriOk }) => {
      if (!colibriOk) {
        // Deferred, not heuristic-scored — doesn't touch the digest, so it
        // must not flip the "Ranked by colibri" banner for entries that DID
        // get scored by colibri in this same run (see colibriOnlineSoFar's
        // use in persistAndPublish/renderDigest below).
        for (const p of chunk) deferredIds.add(p.id);
        if (!DRY_RUN) {
          for (const p of chunk) pendingQueue.set(`${p.source}:${p.id}`, p);
          savePendingQueue();
        }
        console.error(`[main] colibri offline — queued ${chunk.length} posting(s) for retry next run (pending: ${pendingQueue.size})`);
        return;
      }
      // chunkSize is always 1 (config.colibri.chunkSize), so the single
      // posting's real id is unambiguous — trust it over whatever colibri
      // echoed back in its JSON, which can mangle it (observed in
      // production: "gh-riotgames-7312899" came back as "gh-7312899",
      // which would otherwise silently orphan _posting via attachPosting's
      // placeholder fallback and lose the real posting's data).
      if (chunk.length === 1) {
        for (const r of parsed) r.id = chunk[0].id;
      }
      const attached = attachPosting(parsed);
      rankings.push(...attached);
      await persistAndPublish(attached, chunk);
      if (!DRY_RUN) {
        for (const p of chunk) pendingQueue.delete(`${p.source}:${p.id}`);
        savePendingQueue();
      }
    });

    if (rankings.length < candidates.length) {
      const rankedIds = new Set(rankings.map(r => r.id));
      const missing = candidates.filter(p => !rankedIds.has(p.id) && !deferredIds.has(p.id));
      if (missing.length) {
        console.error(`[main] colibri missed ${missing.length} (malformed response, not an outage), filling with heuristic`);
        const filled = attachPosting(heuristicRankings(missing, config.tracks));
        rankings.push(...filled);
        // Already marked seen as part of their chunk above — this only adds
        // the fallback ranking to the digest, not another seen.add.
        await persistAndPublish(filled, []);
      }
    }
  }

  if (!DRY_RUN) pruneOldDigestState();

  // 6. Drafting (opt-in, unaffected by streaming) + final summary. The
  // digest itself is already fully up to date on the volume via
  // persistAndPublish above — this step only adds cover-letter drafts, if
  // requested, on top of what's already written.
  console.error("[main] step 6/6: drafting...");
  if (DRY_RUN) {
    console.log(renderDigest(stamp, rankings, colibriOnlineSoFar));
    console.error("[main] DRY RUN -- no state mutation, no volume write, no drafting");
  } else if (DRAFTS > 0 && !NO_COLIBRI) {
    const drafts = await draftTopN(config, rankings, DRAFTS);
    if (drafts.length) {
      await writeToVolume(latestDigestMd, [], stamp, latestSummaryJson, drafts);
      console.error(`[main] wrote ${drafts.length} draft(s)`);
    }
  }

  console.error(`[main] === done: ${rankings.length} ranked this run, ${candidates.length} candidates, ${freshMatched.length} eligible, ${allPostings.length} total fetched ===`);
}

main().catch(e => {
  console.error(`[main] FATAL: ${e.message}`);
  process.exit(1);
});
