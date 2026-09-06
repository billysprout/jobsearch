// registry.mjs — the pipeline stage tables + the stage interface contract.
//
// Stages are configured by name in configs/base.json (filters / scorers) and
// resolved against the EXPLICIT tables below. Deliberately no dynamic
// import(): a config value never decides what file gets loaded — adding a
// stage is a code change (new module + one table row), which keeps the
// review surface for "what can this config make the pipeline run" to this
// one file.
//
// --- Stage interfaces ------------------------------------------------------
//
// FILTER — runs before dedupe (matched-only-burned-seen semantics preserved:
// only postings that survive the filter chain can ever be marked seen).
//   init(cfg)                    -> params; throws ConfigError on a bad
//                                   filterConfig slice
//   apply(postings, params)      -> { kept, dropped, byReason }
//                                   deterministic; no silent mutation —
//                                   everything the pipeline needs comes back
//                                   in the return value (annotating kept
//                                   postings with debug fields like
//                                   _matchedTrack is fine)
//
// SCORER — ordered chain; each stage receives the previous stage's `missed`.
//   init(cfg)                    -> params
//   score(postings, params, ctx) -> { rankings, deferred, missed, online }
//     rankings  — Ranking[] objects (id/score/track/one_line/fit_notes),
//                 each with `_posting` attached
//     deferred  — postings held for a REAL retry next run (colibri outage);
//                 never heuristic-scored later, never marked seen this run
//     missed    — postings this stage couldn't rank; handed to the next
//                 scorer in the chain
//     online    — whether colibri itself answered (banner bookkeeping)
//     ctx — orchestrator-provided:
//       first        true when this scorer is first in the chain (its input
//                    has NOT been marked seen yet)
//       onRanked(rankings, sourcePostings) — persist + publish NOW (streaming:
//                    a killed run loses at most the chunk in flight).
//                    sourcePostings = postings this ranking makes visible;
//                    the orchestrator marks them seen and drops them from the
//                    pending queue. Pass [] for fallback rankings that only
//                    add to the digest.
//       defer(postings)        — queue for retry next run
//       pendingSize()          — current pending-queue size (for logs)
//   The LAST scorer in the chain must be terminal (missed: []) — anything the
//   chain can't rank would otherwise be silently dropped with no ranking.
//   validateChains() enforces that at startup.
// -----------------------------------------------------------------------------

import { ConfigError } from "../config.mjs";
import * as keywordMatch from "../filters/keyword-match.mjs";
import * as recency from "../filters/recency.mjs";
import * as blocklist from "../filters/blocklist.mjs";
import * as keywordGate from "../scorers/keyword-gate.mjs";
import * as colibriRank from "../scorers/colibri-rank.mjs";
import * as keywordHeuristic from "../scorers/keyword-heuristic.mjs";

export const FILTERS = {
  "keyword-match": keywordMatch,
  // First-party opt-ins, off by default (not in DEFAULTS.filters) — a
  // profile turns them on by listing them and configuring filterConfig.
  "recency": recency,
  "blocklist": blocklist,
};

export const SCORERS = {
  "keyword-gate": { ...keywordGate, terminal: false },
  "colibri": { ...colibriRank, terminal: false },
  // Terminal: always returns missed: [] — the chain always ends with a
  // ranking for every candidate (malformed-gap filler / --no-colibri scorer).
  "keyword-heuristic": { ...keywordHeuristic, terminal: true },
};

function resolve(table, kind, name) {
  const stage = table[name];
  if (!stage) {
    const known = Object.keys(table).map(k => `"${k}"`).join(", ");
    throw new ConfigError(`unknown ${kind} stage: "${name}" (known: ${known})`);
  }
  return stage;
}

export function resolveFilter(name) {
  return resolve(FILTERS, "filter", name);
}

export function resolveScorer(name) {
  return resolve(SCORERS, "scorer", name);
}

/**
 * Validate a config's stage chains: every name must resolve, and the scorer
 * chain must end in a terminal stage. Called by scrape.mjs at startup —
 * a bad chain in a profile should stop the run with a clear message, not
 * silently drop candidates.
 */
export function validateChains(cfg) {
  for (const name of cfg.filters) resolveFilter(name);
  if (!cfg.scorers.length) {
    throw new ConfigError("scorers chain is empty — nothing would ever rank a posting");
  }
  for (const name of cfg.scorers) resolveScorer(name);
  const last = resolveScorer(cfg.scorers[cfg.scorers.length - 1]);
  if (!last.terminal) {
    throw new ConfigError(`last scorer "${cfg.scorers[cfg.scorers.length - 1]}" must be terminal (missed: []) — known terminal scorers: ${
      Object.entries(SCORERS).filter(([, s]) => s.terminal).map(([k]) => `"${k}"`).join(", ")
    }`);
  }
}
