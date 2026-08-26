// colibri.mjs — batch rank + summarize postings via local colibri model.
// Uses built-in fetch with AbortController timeout.
// Note: colibri with stream=false buffers the full response — socket is idle during
// generation, so undici's headersTimeout (default 300s) must not be hit.
// Defensive: strips fences, finds first JSON array. A chunk that errors (offline,
// timeout, bad HTTP response) is NOT heuristic-scored here — it's reported back via
// colibriOk:false with no ranking, and the caller (scrape.mjs) defers it to the
// pending-colibri queue for retry once colibri is back, instead of permanently
// burning it into the digest with a degraded score. heuristicRankings() below is
// still used for explicit --no-colibri runs and the heuristicSkipThreshold pre-gate
// (config.colibri.heuristicSkipThreshold) — both deliberate, not offline fallback.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bestTrackScore } from "./keywords.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @typedef {{ id: string, score: number, track: string, one_line: string, fit_notes: string }} Ranking */

const SYSTEM_PROMPT = `You are a job-posting analyst. Given a batch of job postings, score each one against three role tracks:

1. "esports" — Esports / Gaming Ops (tournament ops, team management, broadcast, competitive gaming)
2. "it-devops" — IT / Sysadmin / DevOps (infrastructure, SRE, cloud, sysadmin, security)
3. "producer-pm" — Producer / Project Management (producer, PM, TPM, delivery, agile)

For EACH posting, return a JSON object with:
- "id": the exact id string from the input (do NOT change it)
- "score": 0-100 (how strong a fit for ANY of the three tracks)
- "track": one of "esports", "it-devops", "producer-pm", or "none"
- "one_line": one sentence explaining why it's relevant (or why it's not)
- "fit_notes": 2-3 bullet points on key fit factors

Return ONLY a JSON array of these objects, one per posting, in the same order as input. No markdown fences, no extra text.`;


/**
 * Rank a batch of postings via colibri.
 * @param {import('./config.json')} config
 * @param {Array<{source: string, id: string, url: string, company: string, title: string, location: string, salary: string, bodyText: string}>} postings
 * @param {(parsed: Ranking[], chunk: Array<object>, info: {colibriOk: boolean}) => (void|Promise<void>)} [onChunkRanked]
 *   Optional callback fired after each chunk resolves — lets the caller
 *   persist/publish incrementally instead of waiting for the whole batch,
 *   since a single chunk can itself take minutes and the batch as a whole
 *   can run for hours. On success, `parsed` holds that chunk's rankings and
 *   `colibriOk` is true. On failure (offline, timeout, bad response),
 *   `parsed` is `[]` and `colibriOk` is false — no ranking was produced, and
 *   the caller is expected to defer `chunk` for retry rather than score it
 *   heuristically. Failures in the callback are logged and swallowed — a
 *   digest-write hiccup must never abort ranking.
 * @returns {Promise<{rankings: Ranking[], colibriOnline: boolean}>}
 */
export async function rankPostings(config, postings, onChunkRanked) {
  if (!postings.length) return { rankings: [], colibriOnline: true };

  const { baseUrl, model, timeoutMs, chunkSize } = config.colibri;
  const endpoint = `${baseUrl}/chat/completions`;
  const allRankings = [];
  let colibriOnline = true;

  async function publishChunk(parsed, chunk, colibriOk) {
    if (!onChunkRanked) return;
    try {
      await onChunkRanked(parsed, chunk, { colibriOk });
    } catch (e) {
      console.error(`[colibri] onChunkRanked callback failed (non-fatal): ${e.message}`);
    }
  }

  for (let i = 0; i < postings.length; i += chunkSize) {
    const chunk = postings.slice(i, i + chunkSize);
    const userPrompt = buildUserPrompt(chunk);

    await waitForMcpColibriIdle(config);

    try {
      console.error(`[colibri] chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(postings.length / chunkSize)}: ${chunk.length} postings, calling ${model}...`, `[t0=${Date.now()}]`);

      const t0 = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // stream:true so colibri sends response headers immediately (avoiding
      // undici headersTimeout during idle prefill). We collect SSE deltas.
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          max_tokens: chunk.length * 256,
          temperature: 0.2,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        clearTimeout(timer);
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      // Collect streamed SSE deltas — accumulate delta.content across chunks.
      // stream:true makes colibri send headers immediately, avoiding undici
      // headersTimeout during idle prefill. Format: standard SSE ("data: {...}\n\n").
      const contentParts = [];
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        contentParts.push(value);
      }
      clearTimeout(timer);

      const raw = Buffer.concat(contentParts).toString();
      let content = "";
      let usage = null;
      try {
        const lines = raw.split("\n").filter(l => l.startsWith("data: "));
        for (const line of lines) {
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (chunk.usage) usage = chunk.usage;
        }
      } catch (e) {
        throw new Error(`Failed to parse SSE stream: ${e.message}`);
      }
      if (!content) throw new Error("Empty content from colibri SSE stream");

      if (usage) console.error(`[colibri] tokens: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`, `[elapsed=${(Date.now() - t0) / 1000}s]`);
      else console.error(`[colibri] no usage in response`, `[elapsed=${(Date.now() - t0) / 1000}s]`);

      const parsed = parseRankingResponse(content, chunk.map(p => p.id));
      allRankings.push(...parsed);
      console.error(`[colibri] parsed ${parsed.length}/${chunk.length} rankings from chunk`);
      await publishChunk(parsed, chunk, true);

    } catch (err) {
      console.error(`[colibri] ERROR: ${err.message} — deferring chunk for retry (no heuristic fallback)`);
      colibriOnline = false;
      // No ranking produced — caller defers this chunk to the pending queue.
      await publishChunk([], chunk, false);
    }
  }

  return { rankings: allRankings, colibriOnline };
}

/**
 * Heuristic fallback when colibri is unreachable.
 * @param {Array<{id: string, title: string, bodyText: string, company: string}>} postings
 * @returns {Ranking[]}
 */
export function heuristicRankings(postings, trackKeywords) {
  // Load config for keywords if not passed
  if (!trackKeywords) {
    const config = JSON.parse(readFileSync(resolve(__dirname, "config.json"), "utf8"));
    trackKeywords = config.tracks;
  }

  return postings.map(p => {
    const text = `${p.title} ${p.company} ${p.bodyText}`.toLowerCase();
    const { track, score } = bestTrackScore(text, trackKeywords);

    return {
      id: p.id,
      score,
      track,
      one_line: score > 0 ? `Keyword match (${track})` : "No track keyword match",
      fit_notes: score > 0 ? "Heuristic score — colibri offline" : "Low relevance to tracked roles",
    };
  });
}

// --- Internal ---

// Best-effort coordination with the in-sandbox `ask_colibri` MCP tool
// (mcp-colibri/), which hits this same colibri process from inside the
// gateway container. Colibri serializes requests (disk-streamed experts,
// one at a time) — if this host-side batch run and an agent's ask_colibri
// call land at the same time, one silently queues behind the other with no
// indication why. mcp-colibri's own /health reports jobs_running; it's
// published to 127.0.0.1 (loopback only, read-only status, no auth) so this
// host-side script can check it. Fails open: if the health URL is
// unreachable (feature not deployed, container down, etc.) this is a no-op
// after one quick attempt — never blocks a run on infrastructure that isn't
// there. Not a lock, just politeness: waits briefly, then proceeds anyway.
async function waitForMcpColibriIdle(config) {
  const healthUrl = config.colibri?.mcpHealthUrl;
  if (!healthUrl) return;

  const maxAttempts = 3;
  const pollDelayMs = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let health;
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return; // unreachable/misconfigured — don't block on it
      health = await res.json();
    } catch {
      return; // mcp-colibri not reachable from the host — nothing to coordinate with
    }

    if (!health.jobs_running) return; // idle, go ahead

    if (attempt < maxAttempts) {
      console.error(`[colibri] mcp-colibri reports ${health.jobs_running} job(s) running via ask_colibri — waiting ${pollDelayMs / 1000}s before firing (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, pollDelayMs));
    } else {
      console.error(`[colibri] mcp-colibri still busy after ${maxAttempts} checks — proceeding anyway (best-effort only, not a hard lock)`);
    }
  }
}

function buildUserPrompt(chunk) {
  const items = chunk.map((p, i) => {
    const excerpt = (p.bodyText || "").substring(0, 800);
    return `${i + 1}. [id: "${p.id}"] ${p.company} — ${p.title}\n   Location: ${p.location || "N/A"} | Salary: ${p.salary || "N/A"}\n   ${excerpt}`;
  });
  return `Score these ${chunk.length} job postings:\n\n${items.join("\n\n")}`;
}

function parseRankingResponse(content, expectedIds) {
  // Strip markdown fences if present
  let cleaned = content.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();

  // Find the first JSON array
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    console.error("[colibri] no JSON array found in response, falling back to heuristic");
    return []; // caller will detect mismatch and use heuristic
  }

  try {
    const arr = JSON.parse(cleaned.substring(start, end + 1));
    if (!Array.isArray(arr)) return [];
    // Validate shape, fill defaults for missing fields
    return arr.map(r => ({
      id: String(r.id || "unknown"),
      score: Math.max(0, Math.min(100, Number(r.score) || 0)),
      track: ["esports", "it-devops", "producer-pm", "none"].includes(r.track) ? r.track : "none",
      one_line: String(r.one_line || "").substring(0, 200),
      fit_notes: String(r.fit_notes || "").substring(0, 500),
    }));
  } catch (e) {
    console.error(`[colibri] JSON parse error: ${e.message}`);
    return [];
  }
}
