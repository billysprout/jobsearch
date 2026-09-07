// colibri.mjs — batch rank + summarize postings via local colibri model.
// Uses built-in fetch with AbortController timeout.
// Note: colibri with stream=false buffers the full response — socket is idle during
// generation, so undici's headersTimeout (default 300s) must not be hit.
// Defensive: strips fences, finds first JSON array. Per chunk, the failure
// order is colibri → gemma fallback (config.gemma — Ollama on the host) →
// defer: only when BOTH engines fail is the chunk reported via colibriOk:false
// with no ranking for the caller (scrape.mjs) to defer to the pending-colibri
// queue — never permanently burned into the digest with a degraded score. A
// gemma-fallback success is a real ranking (entries carry ranker:"gemma"), not
// a degraded one. heuristicRankings() below is still used for explicit
// --no-colibri runs and the heuristicSkipThreshold pre-gate
// (config.colibri.heuristicSkipThreshold) — both deliberate, not offline fallback.

import { bestTrackScore, DEFAULT_KEYWORD_SCORING } from "./keywords.mjs";
import { buildSystemPrompt, trackWhitelist } from "./pipeline/prompt.mjs";

/** @typedef {{ id: string, score: number, track: string, one_line: string, fit_notes: string, ranker?: string }} Ranking */


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
  const generation = config.colibri.generation;
  // Taxonomy derives from config.tracks — see pipeline/prompt.mjs for why
  // the generated prompt's bytes matter (KV cache) and why tracks sort
  // alphabetically.
  const systemPrompt = buildSystemPrompt(config.tracks);
  const whitelist = trackWhitelist(config.tracks);
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
    const userPrompt = buildUserPrompt(chunk, generation);

    await waitForMcpColibriIdle(config);

    try {
      console.error(`[colibri] chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(postings.length / chunkSize)}: ${chunk.length} postings, calling ${model}...`, `[t0=${Date.now()}]`);

      const t0 = Date.now();
      const { content, usage } = await chatCompletionStream(
        { baseUrl, model, timeoutMs, maxTokens: chunk.length * generation.maxTokensPerPosting },
        generation.temperature, systemPrompt, userPrompt,
      );
      logUsage(usage, t0);

      const parsed = parseRankingResponse(content, chunk.map(p => p.id), whitelist, generation);
      for (const r of parsed) r.ranker = "colibri";
      allRankings.push(...parsed);
      console.error(`[colibri] parsed ${parsed.length}/${chunk.length} rankings from chunk`);
      await publishChunk(parsed, chunk, true);

    } catch (err) {
      const gemma = config.gemma;
      if (gemma?.enabled) {
        console.error(`[colibri] ERROR: ${err.message} — trying gemma fallback (${gemma.model})`);
        const gt0 = Date.now();
        try {
          const { content, usage } = await chatCompletionStream(
            { baseUrl: gemma.baseUrl, model: gemma.model, timeoutMs: gemma.timeoutMs, maxTokens: gemma.maxTokens },
            generation.temperature, systemPrompt, userPrompt,
          );
          logUsage(usage, gt0);

          const parsed = parseRankingResponse(content, chunk.map(p => p.id), whitelist, generation);
          // Unlike a malformed colibri success (which falls through to the
          // terminal heuristic scorer), a gemma response with no parseable
          // rankings defers — tomorrow's colibri retry beats burning a
          // heuristic score on fallback-engine garbage.
          if (!parsed.length) throw new Error("no parseable rankings in gemma response");
          for (const r of parsed) r.ranker = "gemma";
          allRankings.push(...parsed);
          console.error(`[colibri] gemma fallback ranked ${parsed.length}/${chunk.length} posting(s) [elapsed=${((Date.now() - gt0) / 1000).toFixed(1)}s]`);
          await publishChunk(parsed, chunk, true);
          continue;
        } catch (gerr) {
          console.error(`[colibri] gemma fallback also failed: ${gerr.message} — deferring chunk for retry (no heuristic fallback)`);
        }
      } else {
        console.error(`[colibri] ERROR: ${err.message} — deferring chunk for retry (no heuristic fallback)`);
      }
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
 * @param {Record<string, {keywords: string[], weight?: number}>} tracks — from config.tracks;
 *   required (every caller already has the config, and a silent disk re-read
 *   here is exactly the kind of hidden IO this refactor removes)
 * @param {{pointsPerKeyword: number, scoreCap: number, defaultWeight: number}} [scoring]
 *   from config.scoring.keyword — omit for the built-in defaults
 * @returns {Ranking[]}
 */
export function heuristicRankings(postings, trackKeywords, scoring = DEFAULT_KEYWORD_SCORING) {
  return postings.map(p => {
    const text = `${p.title} ${p.company} ${p.bodyText}`.toLowerCase();
    const { track, score } = bestTrackScore(text, trackKeywords, scoring);

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

// One engine call: POST {baseUrl}/chat/completions with SSE streaming, buffer
// the whole body, accumulate delta.content. Shared by colibri (primary) and
// the gemma fallback — identical request shape, differing only in the config
// slice (baseUrl/model/timeoutMs/maxTokens). stream:true so the server sends
// response headers immediately (avoiding undici headersTimeout during idle
// prefill). Format: standard SSE ("data: {...}\n\n"). Gemma is
// thinking-capable: while thinking it emits delta.reasoning with content
// present-but-empty, so accumulating only delta.content handles both engines.
// The deadline timer is cleared in a finally — a failed call must not leave
// an armed timer holding the event loop open (each failed chunk used to leak
// one until it fired).
async function chatCompletionStream({ baseUrl, model, timeoutMs, maxTokens }, temperature, systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
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
    if (!content) throw new Error("Empty content from SSE stream");
    return { content, usage };
  } finally {
    clearTimeout(timer);
  }
}

function logUsage(usage, t0) {
  const elapsed = `[elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s]`;
  if (usage) console.error(`[colibri] tokens: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`, elapsed);
  else console.error(`[colibri] no usage in response`, elapsed);
}

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

  const { maxAttempts, pollDelayMs, requestTimeoutMs } = config.colibri.busyCheck;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let health;
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(requestTimeoutMs) });
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

// Fixed intro text regardless of chunk size (chunkSize is 1 in practice —
// see config.json) so every call shares the exact same prefix bytes as the
// SYSTEM_PROMPT before it. Colibri persists its KV cache and matches on
// prefix, so an identical prefix means only the per-posting delta at the end
// needs a fresh prefill — a varying "Score these N postings" count would
// break that match for no benefit (grammatically it always says "1 posting"
// today regardless of wording, so this costs nothing).
const USER_PROMPT_INTRO = "Score the following job posting(s):";

function buildUserPrompt(chunk, generation) {
  const items = chunk.map((p, i) => {
    const excerpt = (p.bodyText || "").substring(0, generation.bodyExcerptChars);
    return `${i + 1}. [id: "${p.id}"] ${p.company} — ${p.title}\n   Location: ${p.location || "N/A"} | Salary: ${p.salary || "N/A"}\n   ${excerpt}`;
  });
  return `${USER_PROMPT_INTRO}\n\n${items.join("\n\n")}`;
}

function parseRankingResponse(content, expectedIds, trackWhitelist, generation) {
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
      track: trackWhitelist.includes(r.track) ? r.track : "none",
      one_line: String(r.one_line || "").substring(0, generation.oneLineMaxChars),
      fit_notes: String(r.fit_notes || "").substring(0, generation.fitNotesMaxChars),
    }));
  } catch (e) {
    console.error(`[colibri] JSON parse error: ${e.message}`);
    return [];
  }
}
