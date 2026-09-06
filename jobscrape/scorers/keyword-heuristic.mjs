// scorers/keyword-heuristic.mjs — keyword scoring as a pipeline stage.
//
// TERMINAL scorer (registry: last position only). Two roles:
//   1. sole scorer under --no-colibri (orchestrator forces the chain to just
//      this stage) — an explicit opt-out, so postings get heuristic-scored
//      NOW, including anything that was sitting in the pending queue, and
//      are marked seen as usual;
//   2. end of the full chain, filling the "colibri succeeded but returned
//      malformed JSON" gaps the earlier stages passed through as `missed`.
//      Those postings were already marked seen as part of their chunk, so
//      ctx.first is false and onRanked receives an empty sourcePostings —
//      the fallback only ADDS rankings to the digest, it doesn't re-mark.
//
// SCORER interface (see pipeline/registry.mjs):
//   score(postings, params, ctx) -> { rankings, deferred, missed, online }

import { heuristicRankings } from "../colibri.mjs";
import { attachPostings } from "../pipeline/render.mjs";

export function init(cfg) {
  return { tracks: cfg.tracks, scoring: cfg.scoring.keyword };
}

export async function score(postings, params, ctx) {
  if (!postings.length) return { rankings: [], deferred: [], missed: [], online: false };

  if (!ctx.first && postings.length) {
    console.error(`[scorer] upstream scorer(s) left ${postings.length} candidate(s) unranked — filling with heuristic scores`);
  }

  const map = new Map(postings.map(p => [p.id, p]));
  const rankings = attachPostings(heuristicRankings(postings, params.tracks, params.scoring), map);
  await ctx.onRanked(rankings, ctx.first ? postings : []);
  return { rankings, deferred: [], missed: [], online: false };
}
