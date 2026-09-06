// scorers/keyword-gate.mjs — heuristic pre-gate in front of colibri.
//
// Colibri throughput is the binding constraint on selection.limit (see
// register-task.ps1), so postings the keyword scorer is already confident
// about (heuristic score >= colibri.heuristicSkipThreshold) skip the colibri
// call entirely and are ranked right now, reserving that budget for
// genuinely ambiguous candidates. This is DELIBERATE heuristic scoring, not
// an outage fallback: gated postings are marked seen and published like any
// other ranking. threshold=null disables the gate entirely.
//
// SCORER interface (see pipeline/registry.mjs):
//   score(postings, params, ctx) -> { rankings, deferred, missed, online }

import { bestTrackScore } from "../keywords.mjs";
import { heuristicRankings } from "../colibri.mjs";
import { attachPostings } from "../pipeline/render.mjs";

export function init(cfg) {
  return {
    threshold: cfg.colibri.heuristicSkipThreshold,
    tracks: cfg.tracks,
    scoring: cfg.scoring.keyword,
  };
}

export async function score(postings, params, ctx) {
  const { threshold, tracks, scoring } = params;

  if (typeof threshold !== "number") {
    return { rankings: [], deferred: [], missed: postings, online: true };
  }

  const scored = postings.map(p => ({
    posting: p,
    ...bestTrackScore(`${p.title} ${p.company} ${p.bodyText}`.toLowerCase(), tracks, scoring),
  }));
  const preGated = scored.filter(s => s.score >= threshold).map(s => s.posting);
  const toRank = scored.filter(s => s.score < threshold).map(s => s.posting);
  if (!preGated.length) {
    return { rankings: [], deferred: [], missed: toRank, online: true };
  }
  console.error(`[main] ${preGated.length} candidate(s) skip colibri (heuristic score >= ${threshold}), ${toRank.length} sent to colibri`);

  const rankings = attachPostings(
    heuristicRankings(preGated, tracks, scoring).map(r => ({
      ...r,
      fit_notes: `${r.fit_notes} — skipped colibri, high-confidence keyword match (>= ${threshold})`,
    })),
    new Map(preGated.map(p => [p.id, p])),
  );
  await ctx.onRanked(rankings, preGated);

  return { rankings, deferred: [], missed: toRank, online: true };
}
