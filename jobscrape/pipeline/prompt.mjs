// prompt.mjs — derives the colibri prompt + track taxonomy from config.tracks.
//
// Before this module the track taxonomy was hardcoded in FOUR places that had
// to be edited in lockstep to add a track: the colibri system prompt, the
// response parser's track whitelist, the digest renderer's byTrack buckets,
// and the summary/notify labels. Now config.tracks is the single source of
// truth and everything else derives from it (see the consumers in colibri.mjs
// and scrape.mjs).
//
// KV-CACHE WARNING — read before touching buildSystemPrompt's template:
// colibri persists its KV cache across calls and matches prompts by PREFIX.
// The fixed system prompt was a deliberate production decision: byte-stable
// prompts mean only the per-posting user-prompt delta needs a fresh prefill;
// a single changed byte up top re-prefills every subsequent call for the rest
// of the day (minutes per chunk — see the README latency notes). So:
//   - tracks are sorted ALPHABETICALLY, not config order: byte-stable no
//     matter how the config file orders them, and today's alphabetical
//     config produces today's exact prompt (pinned by test/prompt.test.mjs)
//   - the em-dashes in track lines are U+2014 ON PURPOSE; do not "fix" them
//     to hyphens (text-filter.mjs's stripEmDash only ever touches LLM OUTPUT,
//     never prompts)
//   - legitimate track edits are fine — they cost ONE re-prefill, then the
//     new bytes cache again
//
// Zero dependencies; golden-byte pinned by test/prompt.test.mjs.

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function countWord(n) {
  return COUNT_WORDS[n] || String(n);
}

/** Sorted track keys — the canonical byte-stable order for every derived artifact. */
export function sortedTrackKeys(tracks) {
  return Object.keys(tracks).sort();
}

/**
 * The track values colibri may return: config tracks (sorted) + "none".
 * Feeds parseRankingResponse's whitelist.
 */
export function trackWhitelist(tracks) {
  return [...sortedTrackKeys(tracks), "none"];
}

/**
 * Render the colibri system prompt from config.tracks.
 * @param {Record<string, {label: string, description: string}>} tracks —
 *   `description` is required (validator enforces it): it's the parenthetical
 *   on each numbered line, e.g. "tournament ops, team management, broadcast".
 */
export function buildSystemPrompt(tracks) {
  const keys = sortedTrackKeys(tracks);
  const numbered = keys
    .map((key, i) => `${i + 1}. "${key}" — ${tracks[key].label} (${tracks[key].description})`)
    .join("\n");
  const count = countWord(keys.length);
  // Comma-joined; the template's trailing `, or "none"` supplies the "or".
  const list = keys.map(k => `"${k}"`).join(", ");

  return `You are a job-posting analyst. Given a batch of job postings, score each one against ${count} role tracks:

${numbered}

For EACH posting, return a JSON object with:
- "id": the exact id string from the input (do NOT change it)
- "score": 0-100 (how strong a fit for ANY of the ${count} tracks)
- "track": one of ${list}, or "none"
- "one_line": one sentence explaining why it's relevant (or why it's not)
- "fit_notes": 2-3 bullet points on key fit factors

Return ONLY a JSON array of these objects, one per posting, in the same order as input. No markdown fences, no extra text.`;
}
