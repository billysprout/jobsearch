// keywords.mjs — shared word-boundary keyword matching for scrape.mjs and
// colibri.mjs's heuristic fallback.
//
// Previously both used `text.includes(kw)`, a plain substring match. That
// let short keywords match inside unrelated words — "aws" matched "laws",
// "draws", "withdraws", "jaws", turning random retail/admin postings into
// false "it-devops" hits. Word-boundary matching (via lookaround, not `\b`,
// so it also behaves correctly for keywords that start/end on punctuation
// like "esport(s)") fixes that class of bug without losing legitimate
// multi-word phrase matches like "team manager" or "site reliability".

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patternCache = new Map();

function patternFor(keyword) {
  let re = patternCache.get(keyword);
  if (!re) {
    const esc = escapeRegex(keyword.toLowerCase());
    re = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "i");
    patternCache.set(keyword, re);
  }
  return re;
}

/** Does `text` contain `keyword` as a whole word/phrase (not as a substring of a longer word)? */
export function keywordMatches(text, keyword) {
  return patternFor(keyword).test(text);
}

/**
 * Find the first track whose keyword list matches `text`, in the order the
 * tracks are declared in config. Returns { track, keyword } or null.
 * @param {string} text
 * @param {Record<string, {keywords: string[]}>} tracks
 */
export function firstTrackMatch(text, tracks) {
  for (const [key, track] of Object.entries(tracks)) {
    for (const kw of track.keywords) {
      if (keywordMatches(text, kw)) return { track: key, keyword: kw };
    }
  }
  return null;
}

// Keyword scoring parameters (config.scoring.keyword; these are the same
// values as DEFAULTS — duplicated here only so keywords.mjs stays importable
// from config-less contexts and legacy callers keep today's behavior).
export const DEFAULT_KEYWORD_SCORING = { pointsPerKeyword: 15, scoreCap: 100, defaultWeight: 1 };

/**
 * Score `text` against every track (count of distinct matching keywords *
 * pointsPerKeyword * track weight, capped at scoreCap) and return the best
 * one.
 * @param {string} text
 * @param {Record<string, {keywords: string[], weight?: number}>} tracks
 * @param {{pointsPerKeyword: number, scoreCap: number, defaultWeight: number}} [scoring]
 *   from config.scoring.keyword — omit for the built-in defaults
 */
export function bestTrackScore(text, tracks, scoring = DEFAULT_KEYWORD_SCORING) {
  const { pointsPerKeyword, scoreCap, defaultWeight } = scoring;
  let bestTrack = "none";
  let bestScore = 0;
  for (const [key, track] of Object.entries(tracks)) {
    const matchCount = track.keywords.filter(kw => keywordMatches(text, kw)).length;
    const score = Math.min(scoreCap, matchCount * pointsPerKeyword * (track.weight || defaultWeight));
    if (score > bestScore) {
      bestScore = Math.round(score);
      bestTrack = key;
    }
  }
  return { track: bestTrack, score: bestScore };
}
