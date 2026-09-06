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
    md += `Ranked by **colibri (${config.colibri.model})**. ${ranked.length} postings scored.\n\n`;
  } else {
    md += `> **colibri: OFFLINE (heuristic scores)** -- keyword-based only.\n\n`;
  }

  for (const [track, items] of Object.entries(byTrack)) {
    if (!items.length) continue;
    items.sort((a, b) => b.score - a.score);
    const label = trackLabels[track] || track;
    md += `## ${label} (${items.length})\n\n`;
    md += `| Score | Company | Title | Location | Fit |\n`;
    md += `|------:|---------|-------|----------|-----|\n`;
    for (const r of items) {
      const posting = r._posting;
      md += `| ${r.score} | ${esc(posting.company)} | [${esc(posting.title)}](${posting.url}) | ${esc(posting.location)} | ${esc(r.one_line)} |\n`;
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
// volume at all.
export function renderSummaryJson(ranked, topNPerTrack = 5) {
  const byTrack = {};
  for (const r of ranked) {
    if (r.track === "none") continue;
    (byTrack[r.track] ||= []).push(r);
  }
  const out = [];
  for (const items of Object.values(byTrack)) {
    items.sort((a, b) => b.score - a.score);
    for (const r of items.slice(0, topNPerTrack)) {
      out.push({
        id: r.id,
        track: r.track,
        score: r.score,
        company: r._posting.company,
        title: r._posting.title,
        url: r._posting.url,
        one_line: r.one_line,
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
