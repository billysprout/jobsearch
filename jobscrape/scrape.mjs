// scrape.mjs — daily job-scrape orchestrator.
// Runs on the Windows HOST (not in the sandbox). Writes results into the
// sandbox workspace volume via a tar-pipe through a one-off alpine container.
//
// Usage:
//   node scrape.mjs --once                   # full run (fetch + colibri + write to volume)
//   node scrape.mjs --once --dry-run          # fetch + colibri, output to stdout, no volume write, no state mutation
//   node scrape.mjs --once --no-colibri       # skip colibri, use heuristic scores only
//   node scrape.mjs --once --limit 5          # cap to 5 postings after pre-filter
//   node scrape.mjs --once --profile dev      # configs/dev.json overlay
//   node scrape.mjs --once --dry-run --limit 5 --no-colibri  # fastest dev mode
//
// Pipeline (stage implementations live in pipeline/, filters/, scorers/ —
// this file is orchestration + persistence only):
//   1. fetch all enabled sources
//   2. filter chain (default: keyword-match — word-boundary matching, see
//      keywords.mjs), BEFORE dedupe: a posting that never matched any track
//      is never marked seen, so improving the keyword list later can still
//      catch it
//   3. drop postings already in state/seen.json or already queued in
//      state/pending-colibri.json (only postings genuinely about to be shown
//      get burned from future consideration)
//   4. order candidates: pending-colibri retries from a prior offline run
//      first (oldest work, first claim on the budget), then curated ATS
//      sources ahead of generic boards, round-robin interleaved across
//      companies (see pipeline/selection.mjs), capped at selection.limit
//   5. scorer chain (default: keyword-gate -> colibri -> keyword-heuristic):
//      high-confidence keyword matches skip colibri, colibri ranks the rest
//      and every ranked chunk is persisted + published IMMEDIATELY (a run
//      killed by the scheduled task's timeout loses at most the chunk in
//      flight), and outage-hit AND malformed-response (parse-0) chunks both
//      defer to state/pending-colibri.json for a real retry — the terminal
//      keyword scorer now only fires under --no-colibri
//      — see pipeline/registry.mjs for the stage interface
//   6. optional cover-letter drafting (--drafts), on top of the
//      already-published digest
//
// --dry-run skips all state/volume writes entirely (no seen.json write, no
// digest-state write, no volume write, no drafting) — side-effect-free.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Run log: tee all console output to logs/run-<UTC date>.log ---
// Installed FIRST, before config load — a fatal ConfigError at 07:00 must
// leave a log behind, not just an absent digest. The scheduled task registers
// no stdout redirection (New-ScheduledTaskAction can't), which is why no
// run-2026-09-07.log existed despite the task firing — the drain log only
// existed because that run was started by hand. Teeing here covers scheduled
// AND manual runs, and because writes are synchronous, a killed run still
// leaves everything up to the kill on disk. Append mode: same-day reruns
// concatenate (run starts are marked by the [main] === line). UTC date,
// matching todayStamp()/digest naming.
import { appendFileSync, mkdirSync } from "node:fs";
import { format } from "node:util";
{
  const logDir = resolve(__dirname, "logs");
  mkdirSync(logDir, { recursive: true });
  const runLogPath = resolve(logDir, `run-${new Date().toISOString().slice(0, 10)}.log`);
  for (const method of ["log", "error"]) {
    const write = console[method].bind(console);
    console[method] = (...args) => {
      write(...args);
      try {
        appendFileSync(runLogPath, args.map(a => (typeof a === "string" ? a : format(a))).join(" ") + "\n");
      } catch { /* logging must never kill a run */ }
    };
  }
}

import { fetchAll } from "./sources.mjs";
import { draftTopN } from "./draft.mjs";
import { writeFilesToVolume } from "./volume-writer.mjs";
import { loadConfig } from "./config.mjs";
import * as state from "./state.mjs";
import { renderDigest, renderSummaryJson, renderCard, buildAgentReadme } from "./pipeline/render.mjs";
import { buildCandidates } from "./pipeline/selection.mjs";
import { validateChains, resolveFilter, resolveScorer } from "./pipeline/registry.mjs";

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

// --- Config + stage chains ---
const config = loadConfig({ profile: PROFILE });
validateChains(config);

// Explicit opt-out, not an outage — the chain collapses to heuristic-only so
// everything gets scored now, including anything sitting in the pending
// queue.
let chainNames = config.scorers;
if (NO_COLIBRI && !(chainNames.length === 1 && chainNames[0] === "keyword-heuristic")) {
  console.error("[main] --no-colibri: forcing scorer chain to [keyword-heuristic]");
  chainNames = ["keyword-heuristic"];
}

const DRY_RUN = DRY_RUN_FLAG || config.run.dryRun;
const LIMIT = LIMIT_FLAG ?? config.selection.limit;
const DRAFTS = HAS_DRAFTS ? (DRAFTS_VALUE || config.run.draftDefaultCount) : 0;
const STATE_DIR = state.getStateDir();
const STAGING_DIR = resolve(__dirname, "staging");

// The "Ranked by colibri" banner reflects chain COMPOSITION, not per-chunk
// health: a heuristic-only run (or --no-colibri) says OFFLINE, but a colibri
// outage mid-run must not flip the banner for entries colibri DID score in
// the same run.
const COLIBRI_IN_CHAIN = chainNames.includes("colibri");

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// --- Workspace writer (tar-pipe into docker volume, see volume-writer.mjs) ---
async function writeToVolume(digestMd, cards, stamp, summaryJson, drafts) {
  const files = [
    { relPath: "README.md", content: buildAgentReadme(config) },
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

  // 2. Filter chain (BEFORE dedupe — see header)
  console.error("[main] step 2/6: keyword pre-filter...");
  let matched = allPostings;
  for (const name of config.filters) {
    const filter = resolveFilter(name);
    const result = filter.apply(matched, filter.init(config));
    matched = result.kept;
  }
  // PRE-seen-filter snapshot: everything that matched a track keyword this
  // run, including postings already seen in a prior run. Answers "did this
  // posting even pass the keyword filter at all?" — see jobscrape/state/last-run-matched.json
  state.writeSnapshot("matched", matched, STATE_DIR);

  // 3. Drop already-seen (only matched postings ever touch `seen`) and
  // anything already sitting in the pending-colibri queue (it'll be
  // re-included below without going through the source fetch again).
  console.error("[main] step 3/6: deduping against seen state...");
  const seen = state.loadSeen(STATE_DIR);
  console.error(`[state] ${seen.size} previously seen postings`);
  const pendingQueue = state.loadPendingQueue(STATE_DIR);
  console.error(`[state] ${pendingQueue.size} posting(s) pending colibri from a prior offline run`);
  const freshMatched = matched.filter(p => !seen.has(`${p.source}:${p.id}`) && !pendingQueue.has(`${p.source}:${p.id}`));
  console.error(`[dedupe] ${freshMatched.length} new-and-relevant, ${matched.length - freshMatched.length} already seen or pending`);
  // POST-seen-filter snapshot: the actual eligible pool this run drew
  // candidates from, before source-priority sorting and limit capping.
  // Answers "why wasn't this scored" for anything NOT in this file despite
  // being in last-run-matched.json — it was filtered here, as already-seen.
  // See jobscrape/state/last-run-eligible.json
  state.writeSnapshot("eligible", freshMatched, STATE_DIR);

  if (!freshMatched.length && !pendingQueue.size) {
    console.error("[main] nothing new to rank -- done");
    return;
  }

  // 4. Order + cap. Pending postings (carried over from a prior colibri
  // outage) go first — see pipeline/selection.mjs.
  console.error("[main] step 4/6: prioritizing + capping...");
  const candidates = buildCandidates(pendingQueue.values(), freshMatched, config.selection);
  console.error(`[main] ${candidates.length} candidates after priority sort + cap (${pendingQueue.size} pending + ${freshMatched.length} new-eligible)`);
  if (config.selection.reservedSlots > 0) {
    console.error(`[main] ${config.selection.reservedSlots} slot(s) reserved for sources with priority >= ${config.selection.reservedSourcePriority}`);
  }

  // 5. Scorer chain. Streaming: every ranked chunk is persisted (seen.json,
  // state/digest-<date>.json) and published to the workspace volume as soon
  // as it's ready — a kill at any point loses at most the one chunk in
  // flight, not the whole run.
  console.error("[main] step 5/6: ranking...");
  const stamp = todayStamp();
  let allTodayRankings = DRY_RUN ? [] : state.loadTodayRankings(stamp, STATE_DIR);
  let rankings = [];

  // Marks `sourcePostings` seen, drops them from the pending queue, merges
  // `newRankings` into today's accumulated state, re-renders, and writes to
  // the workspace volume — so the on-disk digest always reflects everything
  // ranked so far. `sourcePostings` may be `[]` for a fallback ranking that
  // only adds to the digest (postings already marked seen as part of an
  // earlier chunk — see scorers/keyword-heuristic.mjs).
  async function persistAndPublish(newRankings, sourcePostings) {
    if (DRY_RUN || !newRankings.length) return;
    for (const p of sourcePostings) seen.add(`${p.source}:${p.id}`);
    if (sourcePostings.length) state.saveSeen(seen, STATE_DIR);
    if (sourcePostings.length) {
      for (const p of sourcePostings) pendingQueue.delete(`${p.source}:${p.id}`);
      state.savePendingQueue(pendingQueue, STATE_DIR);
    }

    allTodayRankings.push(...newRankings);
    state.saveTodayRankings(stamp, allTodayRankings, STATE_DIR);

    const latestDigestMd = renderDigest(stamp, allTodayRankings, COLIBRI_IN_CHAIN, config);
    const latestSummaryJson = renderSummaryJson(allTodayRankings, config.output.topNPerTrack, config.tracks);
    const cards = newRankings.map(r => ({ id: r.id, content: renderCard(r, config.output.cardExcerptChars) }));
    await writeToVolume(latestDigestMd, cards, stamp, latestSummaryJson, []);
    console.error(`[main] streamed ${newRankings.length} new ranking(s) to digest (${allTodayRankings.length} total today)`);
  }

  const ctxFor = first => ({
    config,
    dryRun: DRY_RUN,
    first,
    onRanked: persistAndPublish,
    defer: postings => {
      if (DRY_RUN) return;
      for (const p of postings) pendingQueue.set(`${p.source}:${p.id}`, p);
      state.savePendingQueue(pendingQueue, STATE_DIR);
    },
    pendingSize: () => pendingQueue.size,
  });

  let remaining = candidates;
  for (let i = 0; i < chainNames.length; i++) {
    const scorer = resolveScorer(chainNames[i]);
    const result = await scorer.score(remaining, scorer.init(config), ctxFor(i === 0));
    rankings.push(...result.rankings);
    remaining = result.missed;
  }

  if (!DRY_RUN) state.pruneOldDigestState(config.output.digestStatePruneDays, STATE_DIR);

  // 6. Drafting (opt-in, unaffected by streaming) + final summary. The
  // digest itself is already fully up to date on the volume via
  // persistAndPublish above — this step only adds cover-letter drafts, if
  // requested, on top of what's already written.
  console.error("[main] step 6/6: drafting...");
  if (DRY_RUN) {
    console.log(renderDigest(stamp, rankings, COLIBRI_IN_CHAIN, config));
    console.error("[main] DRY RUN -- no state mutation, no volume write, no drafting");
  } else if (DRAFTS > 0 && !NO_COLIBRI) {
    const drafts = await draftTopN(config, rankings, DRAFTS);
    if (drafts.length) {
      await writeToVolume(
        renderDigest(stamp, allTodayRankings, COLIBRI_IN_CHAIN, config),
        [], stamp, renderSummaryJson(allTodayRankings, config.output.topNPerTrack, config.tracks), drafts,
      );
      console.error(`[main] wrote ${drafts.length} draft(s)`);
    }
  }

  console.error(`[main] === done: ${rankings.length} ranked this run, ${candidates.length} candidates, ${freshMatched.length} eligible, ${allPostings.length} total fetched ===`);
}

main().catch(e => {
  console.error(`[main] FATAL: ${e.message}`);
  process.exit(1);
});
