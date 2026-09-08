// render.mjs — digest/card/summary rendering, extracted from scrape.mjs.
// Pure functions over (rankings, config) — no state, no IO; the orchestrator
// decides when to write the results. Track labels/buckets/model name all
// derive from config.tracks / config.colibri (see pipeline/prompt.mjs for the
// taxonomy single-source-of-truth note).

/** Rank ids colibri may emit; rankings whose id isn't in the map get a
 * placeholder so a mangled colibri echo can't crash rendering (it loses the
 * real posting's data instead — observed in production as "gh-riotgames-…"
 * coming back as "gh-…"; the single-posting id-trust override in
 * scorers/colibri-rank.mjs makes that path near-impossible today). */
export function attachPostings(list, postingMap) {
  for (const r of list) {
    r._posting = postingMap.get(r.id) || { id: r.id, source: "?", company: "?", title: "?", location: "", salary: "", url: "", bodyText: "" };
  }
  return list;
}

export function renderDigest(dateStr, ranked, colibriOnline, config) {
  const trackLabels = {};
  for (const [key, t] of Object.entries(config.tracks)) trackLabels[key] = t.label;

  // Buckets derive from config.tracks (config order, "none" last) — adding a
  // track in config updates the digest layout without touching this code.
  // Today's config order is alphabetical, matching the pre-derivation
  // literal exactly (parity-guarded by test/parity.test.mjs).
  const byTrack = {};
  for (const key of Object.keys(config.tracks)) byTrack[key] = [];
  byTrack.none = [];
  for (const r of ranked) {
    (byTrack[r.track] || byTrack.none).push(r);
  }

  let md = `# Job Digest — ${dateStr}\n\n`;
  if (colibriOnline) {
    const usedGemma = ranked.some(r => r.ranker === "gemma");
    const engine = config.colibri?.enabled === false
      ? `gemma (${config.gemma.model})`
      : usedGemma
        ? `colibri (${config.colibri.model}) + gemma fallback (${config.gemma.model})`
        : `colibri (${config.colibri.model})`;
    // Per-engine counts in the header — the per-entry attribution is the
    // Engine column below, but the one-line rollup answers "did the fallback
    // fire today?" without reading the table.
    const counts = [];
    const nColibri = ranked.filter(r => r.ranker === "colibri").length;
    const nGemma = ranked.filter(r => r.ranker === "gemma").length;
    if (nColibri) counts.push(`${nColibri} by colibri`);
    if (nGemma) counts.push(`${nGemma} by gemma`);
    const nKeyword = ranked.length - nColibri - nGemma;
    if (nKeyword) counts.push(`${nKeyword} keyword-only`);
    md += `Ranked by **${engine}**. ${ranked.length} postings scored${counts.length ? ` (${counts.join(", ")})` : ""}.\n\n`;
  } else {
    md += `> **colibri: OFFLINE (heuristic scores)** -- keyword-based only.\n\n`;
  }

  for (const [track, items] of Object.entries(byTrack)) {
    if (!items.length) continue;
    items.sort((a, b) => b.score - a.score);
    const label = trackLabels[track] || track;
    md += `## ${label} (${items.length})\n\n`;
    md += `| Score | Company | Title | Location | Fit | Engine |\n`;
    md += `|------:|---------|-------|----------|-----|--------|\n`;
    for (const r of items) {
      const posting = r._posting;
      // Engine attribution per entry: colibri/gemma when an engine scored
      // it, blank for keyword-gate/terminal-heuristic fills (their Fit text
      // already says "Keyword match").
      md += `| ${r.score} | ${esc(posting.company, config.output.tableCellChars)} | [${esc(posting.title, config.output.tableCellChars)}](${posting.url}) | ${esc(posting.location, config.output.tableCellChars)} | ${esc(r.one_line, config.output.tableCellChars)} | ${r.ranker || ""} |\n`;
    }
    md += `\n`;
  }

  return md;
}

// Compact machine-readable summary alongside the markdown digest — top N per
// track, written to digest/<stamp>-summary.json. Purpose-built for
// digest-notify.mjs (push notification) so it doesn't have to parse the
// markdown table; kept separate from state/digest-<date>.json, which is
// jobscrape's own accumulation state and isn't written to the workspace
// volume at all. track_label carries the config.tracks display label so
// consumers (deployed as a single file) never need their own taxonomy copy.
export function renderSummaryJson(ranked, topNPerTrack = 5, tracks = {}) {
  const byTrack = {};
  for (const r of ranked) {
    if (r.track === "none") continue;
    (byTrack[r.track] ||= []).push(r);
  }
  const out = [];
  for (const [track, items] of Object.entries(byTrack)) {
    items.sort((a, b) => b.score - a.score);
    for (const r of items.slice(0, topNPerTrack)) {
      out.push({
        id: r.id,
        track: r.track,
        track_label: tracks[track]?.label || track,
        score: r.score,
        company: r._posting.company,
        title: r._posting.title,
        url: r._posting.url,
        one_line: r.one_line,
        // Only set when a specific engine ranked it; heuristic-scored
        // entries (keyword-gate / terminal fill) carry no ranker field.
        ...(r.ranker ? { ranker: r.ranker } : {}),
      });
    }
  }
  return out;
}

export function renderCard(r, cardExcerptChars = 2000) {
  const p = r._posting;
  return `# ${p.title}\n\n`
    + `- **Company**: ${p.company}\n`
    + `- **Source**: ${p.source}\n`
    + `- **Location**: ${p.location || "N/A"}\n`
    + `- **Salary**: ${p.salary || "N/A"}\n`
    + `- **URL**: ${p.url}\n`
    + `- **Score**: ${r.score}/100 (${r.track})\n`
    + (r.ranker ? `- **Ranker**: ${r.ranker}\n` : "")
    + `- **Fit**: ${r.one_line}\n\n`
    + `## Fit Notes\n${r.fit_notes}\n\n`
    + `## Job Description (excerpt)\n${(p.bodyText || "").substring(0, cardExcerptChars)}\n`;
}

// Tracks line derives from config.tracks (labels with " / " collapsed, as
// "Esports / Gaming Ops" reads better in a digest heading than in a sentence).
export function buildAgentReadme(config) {
  const trackNames = Object
    .values(config.tracks)
    .map(t => t.label.replace(/ \/ /g, "/"))
    .join(", ");
  return [
    "# jobs/",
    "",
    "This directory contains daily job digests scraped from the host machine.",
    "Read the latest digest in digest/ for ranked postings, or individual cards in postings/.",
    "",
    `Tracks: ${trackNames}.`,
    "",
    "digest/<date>-summary.json is a compact top-N-per-track version of the same",
    "date's digest, consumed by digest-notify.mjs for the push notification.",
    "",
    "postings/<id>-draft.md — a draft cover letter, only present when the scrape",
    "was run with --drafts. Read it, edit it, send it yourself; nothing here is",
    "submitted anywhere automatically.",
    "",
    "Files are regenerated daily. Stale digests are safe to delete.",
  ].join("\n");
}

export function esc(s, cellChars = 60) {
  return (s || "").replace(/\|/g, "\\|").replace(/\n/g, " ").substring(0, cellChars);
}
