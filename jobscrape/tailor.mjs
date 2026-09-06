// tailor.mjs — generates a tailored resume for ONE posting via colibri,
// using jobscrape/resume.md (master resume, with [v1]/[v2] variant tags) as
// the source of truth and jobscrape/profile.md as supporting background.
//
// Where draft.mjs answers "what do I say in the note", this answers "which
// of my bullets, with which wording, for THIS job description" — the master
// resume's own header instructs exactly that: keep one wording per bullet,
// delete the rest. colibri makes that selection per-posting.
//
// Usage:
//   node tailor.mjs --posting gh-riotgames-8120735              # full run: colibri + volume write
//   node tailor.mjs --posting <id> --date 2026-08-28            # search a specific day's digest
//   node tailor.mjs --posting <id> --out tailored.md            # also save a local copy
//   node tailor.mjs --posting <id> --local-only                 # skip the volume write
//   node tailor.mjs --list                                      # show postable IDs, exit
//
// Never submits anything anywhere. Writes a markdown file for a human to
// read, edit, and drop into their real resume template.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFilesToVolume } from "./volume-writer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESUME_PATH = resolve(__dirname, "resume.md");
const PROFILE_PATH = resolve(__dirname, "profile.md");
const STATE_DIR = resolve(__dirname, "state");

// --- CLI ---
const args = process.argv.slice(2);
const LIST = args.includes("--list");
const LOCAL_ONLY = args.includes("--local-only");
const outIdx = args.indexOf("--out");
const LOCAL_OUT = outIdx !== -1 ? args[outIdx + 1] : null;
const postingIdx = args.indexOf("--posting");
const POSTING_ID = postingIdx !== -1 ? args[postingIdx + 1] : null;
const dateIdx = args.indexOf("--date");
const DATE = dateIdx !== -1 ? args[dateIdx + 1] : null;

if (!LIST && !POSTING_ID) {
  console.error("Usage: node tailor.mjs --posting <id> [--date YYYY-MM-DD] [--out FILE] [--local-only] | --list");
  process.exit(1);
}

const config = JSON.parse(readFileSync(resolve(__dirname, "config.json"), "utf8"));

// --- Posting lookup ---
// Postings live in state/digest-<date>.json as rankings with a full _posting
// (including bodyText). Scanned newest-first; --date pins to one day.

function digestFiles() {
  try {
    return readdirSync(STATE_DIR)
      .map(name => name.match(/^digest-(\d{4}-\d{2}-\d{2})\.json$/))
      .filter(Boolean)
      .map(m => m[1])
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }
}

function findPosting(id, date) {
  const dates = date ? [date] : digestFiles();
  for (const d of dates) {
    const file = join(STATE_DIR, `digest-${d}.json`);
    if (!existsSync(file)) continue;
    let rankings;
    try {
      rankings = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`[tailor] skipping unparseable ${file}: ${e.message}`);
      continue;
    }
    const hit = rankings.find(r => r.id === id);
    if (hit?._posting?.bodyText) return { stamp: d, ...hit._posting };
  }
  return null;
}

function listCandidates() {
  const rows = [];
  for (const d of digestFiles()) {
    const file = join(STATE_DIR, `digest-${d}.json`);
    let rankings;
    try {
      rankings = JSON.parse(readFileSync(file, "utf8"));
    } catch { continue; }
    for (const r of rankings) {
      const p = r._posting || {};
      rows.push({ id: r.id, date: d, score: r.score, track: r.track, company: p.company || "?", title: p.title || "?" });
    }
  }
  return rows;
}

if (LIST) {
  const rows = listCandidates();
  if (!rows.length) {
    console.error("[tailor] no postings in state/digest-*.json — run scrape.mjs first");
    process.exit(1);
  }
  console.error(`[tailor] ${rows.length} posting(s) available (newest digest first):`);
  for (const r of rows) {
    console.error(`  ${r.id}  [${r.date}]  ${r.score}/100 (${r.track})  ${r.company} — ${r.title}`);
  }
  process.exit(0);
}

// --- Inputs ---
const posting = findPosting(POSTING_ID, DATE);
if (!posting) {
  console.error(`[tailor] posting "${POSTING_ID}" not found${DATE ? ` in digest-${DATE}.json` : " in any state/digest-*.json"} — run "node tailor.mjs --list" to see available IDs`);
  process.exit(1);
}

if (!existsSync(RESUME_PATH)) {
  console.error("[tailor] jobscrape/resume.md not found — the master resume is the source of truth for tailoring");
  process.exit(1);
}
const resume = readFileSync(RESUME_PATH, "utf8");
const profile = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, "utf8") : null;

// --- Colibri call (streaming, same pattern as draft.mjs) ---
const SYSTEM_PROMPT = `You are an expert resume tailor. You will receive the candidate's MASTER resume (which preserves multiple wording variants per bullet, tagged [v1]/[v2]) and a job description. Produce a TAILORED resume for this specific posting:

1. Select ONLY the experiences relevant to this job description. Drop irrelevant sections entirely — a tailored resume is short, not exhaustive.
2. Where the master resume offers wording variants ([v1]/[v2] tags), keep exactly ONE — the version whose emphasis best matches this job description. Never output variant tags.
3. Reorder so the strongest, most relevant material is first. Keep the candidate's real metrics and numbers.
4. Use ONLY facts present in the master resume or candidate profile. Never invent employers, dates, titles, skills, or achievements. Never fill gaps with plausible-sounding content.
5. If a required qualification is genuinely not backed by the resume, do not paper over it — omit rather than fabricate.
6. Keep it to what fits on two pages. Output clean markdown: name/contact header, Experience, and only the sections that survived selection. No preamble, no commentary, no markdown code fences.`;

async function tailorResume(config, { resume, profile, posting }) {
  const { baseUrl, model, timeoutMs } = config.colibri;
  const endpoint = `${baseUrl}/chat/completions`;

  const userPrompt = [
    "MASTER RESUME (with variant tags — pick one wording per bullet):",
    resume.trim(),
    "",
    "CANDIDATE PROFILE (supplementary context):",
    (profile || "(not available)").trim(),
    "",
    "JOB DESCRIPTION:",
    `${posting.company} — ${posting.title}`,
    `Location: ${posting.location || "N/A"}`,
    (posting.bodyText || "").substring(0, 8000),
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
        // A full two-page resume is the output — far beyond draft.mjs's 512.
        max_tokens: 4096,
        temperature: 0.3,
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

// --- Output ---
function renderTailoredCard(posting, stamp, tailored) {
  return `# Tailored resume — ${posting.title} @ ${posting.company}\n\n`
    + `> Generated by colibri from jobscrape/resume.md (master resume) for this `
    + `posting. Read it, fix anything wrong, and drop it into your real resume `
    + `template — nothing here is submitted anywhere.\n\n`
    + `- **Posting**: [${posting.url}](${posting.url})\n`
    + `- **Source digest**: ${stamp}\n\n`
    + `---\n\n${tailored}\n`;
}

console.error(`[tailor] tailoring for ${posting.company} — ${posting.title} (digest ${posting.stamp}) via ${config.colibri.model}...`);
console.error(`[tailor] this is a full-resume generation — colibri may take 10+ minutes (see README latency notes)`);

const tailored = await tailorResume(config, { resume, profile, posting });

const card = renderTailoredCard(posting, posting.stamp, tailored);

if (LOCAL_OUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(LOCAL_OUT, card);
  console.error(`[tailor] wrote local copy -> ${LOCAL_OUT}`);
}

if (LOCAL_ONLY) {
  console.error("[tailor] --local-only set, skipping volume write");
} else {
  await writeFilesToVolume({
    volume: config.workspaceVolume,
    targetPath: config.workspacePath,
    stagingDir: resolve(__dirname, "staging"),
    files: [{ relPath: `postings/${POSTING_ID}-tailored.md`, content: card }],
  });
  console.error(`[tailor] wrote postings/${POSTING_ID}-tailored.md to the workspace volume`);
}

console.log(tailored);
