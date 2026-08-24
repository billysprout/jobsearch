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
//   3. drop postings already in state/seen.json (dedupe happens AFTER the
//      filter now — a posting that never matched any track is never marked
//      seen, so improving the keyword list later can still catch it; only
//      postings that are genuinely about to be shown get burned from future
//      consideration)
//   4. sort candidates so curated ATS sources (greenhouse/lever — companies
//      we deliberately chose to track) rank ahead of generic job boards
//      before applying --limit, so the cap doesn't get exhausted by noisy
//      high-volume sources before it ever reaches the curated ones
//   5. rank via colibri (or heuristic fallback)
//   6. mark the ranked set (only) as seen; save state
//   7. merge into today's accumulated digest (state/digest-<date>.json) so a
//      second run on the same day supplements rather than silently
//      overwrites the first run's results
//   8. render + write to the workspace volume
//
// --dry-run skips steps 6-8 entirely (no state.json write, no digest-state
// write, no volume write) — it's now actually side-effect-free, unlike the
// previous version which mutated seen.json even in dry-run mode.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { fetchAll } from "./sources.mjs";
import { rankPostings, heuristicRankings } from "./colibri.mjs";
import { firstTrackMatch } from "./keywords.mjs";

// --- CLI ---
const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const DRY_RUN = args.includes("--dry-run");
const NO_COLIBRI = args.includes("--no-colibri");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? Number(args[limitIdx + 1]) || 40 : 40;

if (!ONCE) {
  console.error("Usage: node scrape.mjs --once [--dry-run] [--limit N] [--no-colibri]");
  process.exit(1);
}

// --- Config ---
const config = JSON.parse(readFileSync(resolve(__dirname, "config.json"), "utf8"));
const STATE_DIR = resolve(__dirname, "state");
const STAGING_DIR = resolve(__dirname, "staging");

// Curated ATS sources (companies we deliberately picked) rank ahead of
// generic job boards when the --limit cap is applied.
const SOURCE_PRIORITY = { greenhouse: 0, lever: 0, remotive: 1, hn: 1, remoteok: 2, wwr: 2 };
function sourcePriority(source) {
  return SOURCE_PRIORITY[source] ?? 3;
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
  "Files are regenerated daily. Stale digests are safe to delete.",
].join("\n");

function esc(s) {
  return (s || "").replace(/\|/g, "\\|").replace(/\n/g, " ").substring(0, 60);
}

// --- Workspace writer (tar-pipe into docker volume) ---
async function writeToVolume(digestMd, cards, stamp) {
  const vol = config.workspaceVolume;
  const target = config.workspacePath;

  mkdirSync(STAGING_DIR, { recursive: true });
  mkdirSync(join(STAGING_DIR, "digest"), { recursive: true });
  mkdirSync(join(STAGING_DIR, "postings"), { recursive: true });

  writeFileSync(join(STAGING_DIR, "README.md"), AGENT_README);
  writeFileSync(join(STAGING_DIR, "digest", `${stamp}.md`), digestMd);
  for (const card of cards) {
    writeFileSync(join(STAGING_DIR, "postings", `${card.id}.md`), card.content);
  }

  console.error(`[volume] staging ${cards.length + 2} files into ${vol}:${target}`);

  return new Promise((resolvePromise, reject) => {
    const tarArgs = ["-cf", "-", "-C", STAGING_DIR, "."];
    const dockerArgs = [
      "run", "--rm", "-i",
      "-v", `${vol}:/w`,
      "alpine", "sh", "-c", "mkdir -p /w/jobs && tar -xf - -C /w/jobs"
    ];

    console.error(`[volume] tar | docker ... alpine tar`);

    const tarProc = execFile("tar", tarArgs, { stdio: ["pipe", "pipe", "pipe"] }, (err) => {
      if (err) reject(new Error(`tar: ${err.message}`));
    });
    const dockerProc = execFile("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] }, (err) => {
      if (err) reject(new Error(`docker: ${err.message}`));
      else resolvePromise();
    });

    tarProc.stdout.pipe(dockerProc.stdin);
    tarProc.stderr.on("data", d => console.error(`[tar] ${d}`));
    dockerProc.stderr.on("data", d => console.error(`[docker] ${d}`));
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

  // 3. Drop already-seen (only matched postings ever touch `seen`)
  console.error("[main] step 3/6: deduping against seen state...");
  const freshMatched = matched.filter(p => !seen.has(`${p.source}:${p.id}`));
  console.error(`[dedupe] ${freshMatched.length} new-and-relevant, ${matched.length - freshMatched.length} already seen`);
  // POST-seen-filter snapshot: the actual eligible pool this run drew
  // candidates from, before source-priority sorting and --limit capping.
  // Answers "why wasn't this scored" for anything NOT in this file despite
  // being in last-run-matched.json — it was filtered here, as already-seen.
  // See jobscrape/state/last-run-eligible.json
  writeSnapshot("eligible", freshMatched);

  if (!freshMatched.length) {
    console.error("[main] nothing new to rank -- done");
    return;
  }

  // 4. Sort by source priority (curated ATS first), then cap
  console.error("[main] step 4/6: prioritizing + capping...");
  const sorted = [...freshMatched].sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source));
  const candidates = sorted.slice(0, LIMIT);
  console.error(`[main] ${candidates.length} candidates after priority sort + cap (of ${freshMatched.length} eligible)`);

  // 5. Rank via colibri (or heuristic)
  console.error("[main] step 5/6: ranking...");
  let rankings, colibriOnline;
  if (NO_COLIBRI) {
    rankings = heuristicRankings(candidates, config.tracks);
    colibriOnline = false;
  } else {
    const result = await rankPostings(config, candidates);
    rankings = result.rankings;
    colibriOnline = result.colibriOnline;

    if (rankings.length < candidates.length) {
      const rankedIds = new Set(rankings.map(r => r.id));
      const missing = candidates.filter(p => !rankedIds.has(p.id));
      if (missing.length) {
        console.error(`[main] colibri missed ${missing.length}, filling with heuristic`);
        rankings.push(...heuristicRankings(missing, config.tracks));
      }
    }
  }

  const postingMap = new Map(candidates.map(p => [p.id, p]));
  for (const r of rankings) {
    r._posting = postingMap.get(r.id) || { id: r.id, source: "?", company: "?", title: "?", location: "", salary: "", url: "", bodyText: "" };
  }

  // Only NOW mark these as seen — postings that got cut by --limit stay
  // eligible for the next run instead of being silently lost forever.
  if (!DRY_RUN) {
    for (const p of candidates) seen.add(`${p.source}:${p.id}`);
    saveSeen();
  }

  // 6. Merge with today's accumulated rankings, render, write
  console.error("[main] step 6/6: rendering + writing digest...");
  const stamp = todayStamp();

  let allTodayRankings = rankings;
  if (!DRY_RUN) {
    const priorToday = loadTodayRankings(stamp);
    allTodayRankings = [...priorToday, ...rankings];
    saveTodayRankings(stamp, allTodayRankings);
    pruneOldDigestState();
  }

  const digestMd = renderDigest(stamp, allTodayRankings, colibriOnline);
  const cards = rankings.map(r => ({ id: r.id, content: renderCard(r) }));

  if (DRY_RUN) {
    console.log(digestMd);
    console.error("[main] DRY RUN -- no state mutation, no volume write");
  } else {
    await writeToVolume(digestMd, cards, stamp);
    console.error(`[main] written to workspace volume (${allTodayRankings.length} total ranked today, ${rankings.length} new this run)`);
  }

  console.error(`[main] === done: ${rankings.length} ranked this run, ${candidates.length} candidates, ${freshMatched.length} eligible, ${allPostings.length} total fetched ===`);
}

main().catch(e => {
  console.error(`[main] FATAL: ${e.message}`);
  process.exit(1);
});
