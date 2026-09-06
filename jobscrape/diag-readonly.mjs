// diag-readonly.mjs — READ-ONLY diagnostic. Does not touch seen.json or state/.
// Re-fetches all sources fresh, cross-references against the existing seen.json
// to recover titles/companies for what's already marked seen, and reports how
// many would pass the keyword pre-filter (without mutating anything).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAll } from "./sources.mjs";
import { firstTrackMatch } from "./keywords.mjs";
import { loadConfig } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const seen = new Set(JSON.parse(readFileSync(resolve(__dirname, "state", "seen.json"), "utf8")));

console.error(`[diag] seen.json has ${seen.size} entries (read-only, not modifying)`);

const all = await fetchAll(config);
console.error(`[diag] fresh fetch: ${all.length} postings`);

// Same matcher the scrape pipeline uses (keywords.mjs word-boundary match).
// This used to be its own `text.includes(kw)` loop, i.e. the pre-aws/laws-fix
// substring matcher — so this diag reported inflated match counts that the
// real pipeline never acted on.
function matchesAnyTrack(p) {
  const text = `${p.title} ${p.company} ${p.bodyText}`;
  return firstTrackMatch(text, config.tracks);
}

const bySource = {};
let matchedCount = 0, unmatchedCount = 0, notInSeen = 0;
const matchedRows = [];
const unmatchedSample = [];

for (const p of all) {
  const key = `${p.source}:${p.id}`;
  bySource[p.source] = (bySource[p.source] || 0) + 1;
  if (!seen.has(key)) { notInSeen++; continue; }
  const m = matchesAnyTrack(p);
  if (m) {
    matchedCount++;
    matchedRows.push({ source: p.source, company: p.company, title: p.title, track: m.track, keyword: m.keyword });
  } else {
    unmatchedCount++;
    if (unmatchedSample.length < 15) unmatchedSample.push({ source: p.source, company: p.company, title: p.title });
  }
}

console.error(`\n[diag] fetched-per-source: ${JSON.stringify(bySource, null, 2)}`);
console.error(`\n[diag] of currently-seen postings still fetchable now:`);
console.error(`  matched a track keyword: ${matchedCount}`);
console.error(`  did NOT match any track: ${unmatchedCount}`);
console.error(`  fetched-but-not-in-seen (new since last run): ${notInSeen}`);

console.error(`\n[diag] === ALL keyword-matched postings (would have become candidates) ===`);
for (const r of matchedRows) {
  console.error(`  [${r.track} via "${r.keyword}"] ${r.source} | ${r.company} — ${r.title}`);
}

console.error(`\n[diag] === sample of unmatched (first 15) ===`);
for (const r of unmatchedSample) {
  console.error(`  ${r.source} | ${r.company} — ${r.title}`);
}
