// state.mjs — all state/ file IO for the scrape pipeline, extracted verbatim
// from scrape.mjs so the orchestrator reads as control flow instead of
// filesystem detail, and so tests can point runs at a fixture directory.
//
// File formats are FROZEN — production has days of accumulated history and
// colibri rankings are expensive to recompute:
//   seen.json             JSON array of "source:id" strings
//   pending-colibri.json  JSON array of posting objects (colibri-outage retries)
//   digest-<date>.json    JSON array of rankings, each with a full `_posting`
//   last-run-<name>.json  debug snapshots, overwritten every run (incl. dry-run)
//
// JOBSCRAPE_STATE_DIR overrides the directory (test seam — the parity run
// replays against a frozen state snapshot so golden diffs measure code drift,
// not live seen.json growth). Production runs never set it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getStateDir() {
  return process.env.JOBSCRAPE_STATE_DIR
    ? resolve(process.env.JOBSCRAPE_STATE_DIR)
    : resolve(__dirname, "state");
}

// --- seen.json: postings that have been ranked and published ---
export function loadSeen(stateDir = getStateDir()) {
  const file = join(stateDir, "seen.json");
  if (existsSync(file)) return new Set(JSON.parse(readFileSync(file, "utf8")));
  return new Set();
}

export function saveSeen(seen, stateDir = getStateDir()) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "seen.json"), JSON.stringify([...seen], null, 0));
}

// --- pending-colibri.json: postings that matched a track but couldn't be
// ranked because colibri was offline. They are deliberately NOT marked seen
// and NOT written to the digest with a heuristic score — they're carried
// forward run to run (oldest first) until colibri is back to actually score
// them, so a colibri outage delays a posting's appearance rather than
// permanently degrading it to a keyword guess.
export function loadPendingQueue(stateDir = getStateDir()) {
  const file = join(stateDir, "pending-colibri.json");
  if (existsSync(file)) {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return new Map(list.map(p => [`${p.source}:${p.id}`, p]));
  }
  return new Map();
}

export function savePendingQueue(pendingQueue, stateDir = getStateDir()) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "pending-colibri.json"), JSON.stringify([...pendingQueue.values()], null, 0));
}

// --- digest-<date>.json: today's accumulated rankings (fixes same-day
// overwrite — a second run supplements rather than clobbers the first) ---
export function digestStateFile(stamp, stateDir = getStateDir()) {
  return join(stateDir, `digest-${stamp}.json`);
}

export function loadTodayRankings(stamp, stateDir = getStateDir()) {
  const f = digestStateFile(stamp, stateDir);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    console.error(`[digest-state] failed to parse ${f}, starting fresh`);
    return [];
  }
}

export function saveTodayRankings(stamp, rankings, stateDir = getStateDir()) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(digestStateFile(stamp, stateDir), JSON.stringify(rankings, null, 0));
}

// Light housekeeping: prune digest-state files older than N days so state/
// doesn't grow forever. Best-effort — never fatal.
export function pruneOldDigestState(days, stateDir = getStateDir()) {
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(stateDir)) {
      const m = name.match(/^digest-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const fileTime = Date.parse(m[1] + "T00:00:00Z");
      if (fileTime < cutoff) unlinkSync(join(stateDir, name));
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
export function writeSnapshot(name, postings, stateDir = getStateDir()) {
  mkdirSync(stateDir, { recursive: true });
  const rows = postings.map(p => ({
    source: p.source, id: p.id, company: p.company, title: p.title, url: p.url,
    matchedTrack: p._matchedTrack, matchedKeyword: p._matchedKeyword,
  }));
  writeFileSync(join(stateDir, `last-run-${name}.json`), JSON.stringify(rows, null, 2));
}
