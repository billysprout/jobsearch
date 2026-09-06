// draft.mjs — generates draft cover letters for top-ranked postings via
// colibri, using jobscrape/profile.md as the candidate's background.
//
// Opt-in only (--drafts flag in scrape.mjs) and capped to a small top-N —
// colibri throughput is already the binding constraint on --limit (see
// the parent README), so drafting deliberately spends that budget on a
// handful of the best matches, not every posting.
//
// Never submits anything anywhere. Writes a markdown file for a human to
// read, edit, and send by hand — see the card template below.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { coverLetterToPdf } from "./pdf.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = resolve(__dirname, "profile.md");

/**
 * Pulls the candidate's name + contact line from profile.md's "## Candidate"
 * section (see profile.example.md), for the PDF letterhead only — never
 * sent to colibri separately, it's already part of the profile text colibri
 * gets in full.
 */
function parseCandidateHeader(profile) {
  const lines = profile.split("\n");
  const idx = lines.findIndex(l => l.trim().toLowerCase() === "## candidate");
  if (idx === -1) return { name: "", contactLine: "" };
  const rest = lines.slice(idx + 1).map(l => l.trim()).filter(Boolean);
  return { name: rest[0] || "", contactLine: rest[1] || "" };
}

const SYSTEM_PROMPT = `You are helping a job candidate draft a short, genuine cover letter. Use ONLY the background provided below — never invent employers, dates, skills, or achievements that aren't in it. If the candidate's background is a weak fit for this posting, say so plainly in the draft rather than papering over the gap. Keep it under 250 words. Do not leave placeholders like "[Hiring Manager]" — write "Hiring Team" if no name is given. Output ONLY the letter text: no preamble, no markdown fences, no commentary.`;

/** Returns the raw profile text, or null if jobscrape/profile.md doesn't exist. */
export function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return null;
  return readFileSync(PROFILE_PATH, "utf8");
}

/**
 * Draft one cover letter via colibri. Reuses the streaming pattern from
 * colibri.mjs (stream: true — required so colibri sends headers immediately
 * instead of buffering the whole generation, which trips undici's
 * headers-timeout on a slow local model).
 */
export async function draftCoverLetter(config, profile, posting) {
  const { baseUrl, model, timeoutMs } = config.colibri;
  const endpoint = `${baseUrl}/chat/completions`;

  const userPrompt = [
    `Candidate background:`,
    profile.trim(),
    ``,
    `Job posting:`,
    `${posting.company} — ${posting.title}`,
    `Location: ${posting.location || "N/A"}`,
    (posting.bodyText || "").substring(0, config.draft.bodyExcerptChars),
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: config.draft.maxTokens,
        temperature: config.draft.temperature,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const contentParts = [];
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      contentParts.push(value);
    }

    const raw = Buffer.concat(contentParts).toString();
    let content = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
      } catch {
        // partial/malformed SSE line — skip it
      }
    }
    if (!content) throw new Error("Empty content from colibri SSE stream");
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Draft cover letters for the top N rankings by score. Best-effort per
 * posting — one failure doesn't abort the rest. Returns [{id, content}]
 * cards ready to write alongside postings/<id>.md as postings/<id>-draft.md.
 * Returns [] (with a logged reason) if profile.md doesn't exist.
 */
export async function draftTopN(config, rankings, n) {
  const profile = loadProfile();
  if (!profile) {
    console.error("[draft] jobscrape/profile.md not found (copy profile.example.md and fill it in) — skipping cover-letter drafts");
    return [];
  }
  const { name: candidateName, contactLine } = parseCandidateHeader(profile);

  const top = [...rankings].sort((a, b) => b.score - a.score).slice(0, n);
  const drafts = [];
  for (const r of top) {
    const posting = r._posting;
    console.error(`[draft] drafting cover letter for ${posting.company} — ${posting.title} (score ${r.score})...`);
    try {
      const letter = await draftCoverLetter(config, profile, posting);
      const draft = { id: r.id, content: renderDraftCard(r, posting, letter) };
      try {
        draft.pdfBuffer = await coverLetterToPdf({ candidateName, contactLine, posting, letter });
      } catch (e) {
        console.error(`[draft] PDF render failed for ${posting.company} — ${posting.title} (keeping the .md draft): ${e.message}`);
      }
      drafts.push(draft);
    } catch (e) {
      console.error(`[draft] ${posting.company} — ${posting.title}: ${e.message}`);
    }
  }
  return drafts;
}

function renderDraftCard(r, posting, letter) {
  return `# Draft cover letter — ${posting.title} @ ${posting.company}\n\n`
    + `> Generated by colibri from jobscrape/profile.md. Read it, fix anything wrong, `
    + `and send it yourself — nothing here is submitted automatically. A formatted `
    + `PDF of this same letter is at \`${r.id}-draft.pdf\` alongside this file.\n\n`
    + `- **Posting**: [${posting.url}](${posting.url})\n`
    + `- **Score**: ${r.score}/100 (${r.track})\n\n`
    + `---\n\n${letter}\n`;
}
