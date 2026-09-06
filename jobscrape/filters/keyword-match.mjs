// filters/keyword-match.mjs — the keyword pre-filter as a pipeline stage.
// Runs BEFORE dedupe (matched-only-burned-seen semantics: a posting that
// never matched any track is never marked seen, so improving the keyword
// list later can still catch it). Word-boundary matching, see keywords.mjs.
//
// FILTER interface (see pipeline/registry.mjs):
//   init(cfg)                  -> params (throws on bad filterConfig slice)
//   apply(postings, params)    -> { kept, dropped, byReason }

import { firstTrackMatch } from "../keywords.mjs";

export function init(cfg) {
  // No options in filterConfig yet — if one appears, validate it here and
  // throw ConfigError on nonsense rather than silently defaulting.
  return { tracks: cfg.tracks };
}

export function apply(postings, params) {
  const matched = [];
  let unmatched = 0;

  for (const p of postings) {
    const text = `${p.title} ${p.company} ${p.bodyText}`.toLowerCase();
    const hit = firstTrackMatch(text, params.tracks);
    if (hit) {
      // Stashed for the debug snapshots — lets you see *why* something
      // matched without re-running the filter logic by hand.
      p._matchedTrack = hit.track;
      p._matchedKeyword = hit.keyword;
      matched.push(p);
    } else {
      unmatched++;
    }
  }
  console.error(`[filter] ${matched.length} matched, ${unmatched} skipped (no keyword overlap)`);
  return { kept: matched, dropped: unmatched, byReason: { "no-keyword-overlap": unmatched } };
}
