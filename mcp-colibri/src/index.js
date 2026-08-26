// mcp-colibri — MCP tool server that proxies to a local colibri model.
//
// Exposes three tools:
//   ask_colibri   — fires a prompt at colibri, returns a job_id immediately
//                    (does NOT block waiting for colibri's answer)
//   check_colibri — polls a job_id for its current status/result
//   list_colibri  — lists recent jobs and their status, so the agent can see
//                    what's in flight/done without needing a job_id in hand
//
// Colibri (359 GB MoE, disk-streamed experts) can take 1-15+ minutes per
// query. A synchronous tool call that blocks for that long holds the calling
// agent session's turn open for the whole wait; if a second message arrives
// on that session in the meantime, OpenClaw's session lock gets released and
// re-acquired, and the original turn can lose the race and be discarded
// (EmbeddedAttemptSessionTakeoverError) once colibri finally responds. The
// fire-and-poll split avoids ever holding a turn open that long: ask_colibri
// returns in milliseconds, and check_colibri is a separate short-lived call
// the agent (or a later message from the user) can make once or repeatedly.
//
// Transport: SSE (Server-Sent Events) over HTTP.
// All colibri requests are proxied through the squid egress proxy
// (forced by HTTP_PROXY env var — same pattern as the gateway).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "node:http";
import { randomUUID } from "node:crypto";

// --- Configuration (all overridable via env) ---
const COLIBRI_BASE_URL = process.env.COLIBRI_BASE_URL || "http://host.docker.internal:8000/v1";
const COLIBRI_MODEL = process.env.COLIBRI_MODEL || "glm-5.2-colibri";
const COLIBRI_TIMEOUT_MS = parseInt(process.env.COLIBRI_TIMEOUT_MS || "900000", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);
const LOG_LEVEL = process.env.LOG_LEVEL || "warn"; // debug | info | warn

// How long a finished (done/error) job stays in memory before being swept.
// Generous — an agent turn hours later should still be able to read a stale
// result rather than get a confusing "unknown job_id".
const JOB_RETENTION_MS = 4 * 60 * 60 * 1000; // 4h
const JOB_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15m

const log = {
  debug: (...args) => LOG_LEVEL === "debug" && console.error("[DEBUG]", ...args),
  info:  (...args) => ["debug", "info"].includes(LOG_LEVEL) && console.error("[INFO]", ...args),
  warn:  (...args) => console.error("[WARN]", ...args),
};

// --- Job store (module-level: shared across all SSE connections/sessions) ---
/**
 * @typedef {{
 *   id: string,
 *   status: "running" | "done" | "error",
 *   promptPreview: string,
 *   createdAt: number,
 *   finishedAt?: number,
 *   result?: string,
 *   error?: string,
 *   delivered: boolean,
 *   partialContent: string,
 *   lastChunkAt?: number,
 *   chunkCount: number,
 * }} Job
 */
/** @type {Map<string, Job>} */
const jobs = new Map();

function sweepOldJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.status !== "running" && (job.finishedAt ?? 0) < cutoff) jobs.delete(id);
  }
}
setInterval(sweepOldJobs, JOB_SWEEP_INTERVAL_MS).unref();

// --- Tool: ask_colibri (fire, non-blocking) ---
const ASK_TOOL_DESC = [
  "Fire a prompt at the local GLM-5.2-colibri model (359 GB MoE, 131K context window).",
  "Returns IMMEDIATELY with a job_id — it does NOT wait for colibri's answer.",
  "",
  "LATENCY — actually measured on this deployment (small sample, take as a feel",
  "for the shape, not a guarantee):",
  "  tiny prompt (~11-16 tok in), warm cache (recently used)  →  ~6s",
  "  tiny prompt (~11-16 tok in), cold-ish cache               →  ~68s",
  "  That's an ~11x swing on essentially the same prompt size — cache state",
  "  (which experts are already pinned/warm) matters more than prompt size at",
  "  this scale. First query after colibri has been idle a while will be slow.",
  "Colibri's own docs give these bands for larger, unmeasured prompt sizes:",
  "  200-500 tokens input  →  5-10 minutes",
  "  > 500 tokens input  →  10+ minutes",
  "",
  "After calling this, use check_colibri with the returned job_id to get the",
  "result. Do NOT block your reply on the result being ready yet — tell the",
  "user you've kicked off a local-model query and will follow up, or that",
  "they can ask again in a bit. Checking once every 1-2 minutes is reasonable;",
  "checking more than once every ~20s is pointless (colibri hasn't finished).",
  "",
  "Use for:",
  "  - Tasks where all data must stay on-local machine (no external API)",
  "  - Fallback when the primary model is quota-exhausted or unavailable",
  "  - Comparing outputs between local and cloud models",
  "",
  "Do NOT use for anything where the user is waiting live for a fast reply —",
  "colibri is slow by design (disk-streamed 744-parameter... 359GB MoE).",
].join("\n");

const ASK_TOOL_PARAMS = {
  prompt: z.string().describe("The user prompt to send to colibri"),
  system: z.string().optional().describe("Optional system prompt (adds to input token count — keep under 100 tokens to avoid timeout)"),
  max_tokens: z.number().optional().describe("Max tokens to generate (default: 4096)"),
};

async function handleAskColibri({ prompt, system, max_tokens }) {
  const id = randomUUID();
  const job = {
    id,
    status: "running",
    promptPreview: prompt.slice(0, 120),
    createdAt: Date.now(),
    delivered: false,
    partialContent: "",
    chunkCount: 0,
  };
  jobs.set(id, job);

  log.info(`>>> ask_colibri job=${id}  prompt=${prompt.length}ch  system=${!!system}  max_tokens=${max_tokens || 4096}`);

  // Fire the actual request in the background — NOT awaited here.
  runColibriJob(job, { prompt, system, max_tokens }).catch(err => {
    // runColibriJob is written to never reject, but guard anyway so an
    // unexpected throw can't produce an unhandled rejection.
    job.status = "error";
    job.error = `internal: ${err?.message || String(err)}`;
    job.finishedAt = Date.now();
  });

  return {
    content: [{
      type: "text",
      text: `Colibri query started. job_id: ${id}\n`
        + `Call check_colibri with this job_id to get the result once ready. `
        + `Do not wait here — reply to the user now and check back later.`,
    }],
  };
}

async function runColibriJob(job, { prompt, system, max_tokens }) {
  const t0 = Date.now();
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COLIBRI_TIMEOUT_MS);

  try {
    // stream:true so colibri sends response headers immediately instead of
    // buffering the whole generation. With stream:false the socket sits idle
    // during prefill+decode, and undici's default 300s headersTimeout aborts
    // the connection long before a slow/large colibri response finishes —
    // colibri's server then sees that as a forcible reset, having done all
    // that expensive prefill work for nothing. (jobscrape/colibri.mjs already
    // does this correctly; this was a gap from the original synchronous
    // version of this file that the fire-and-poll rewrite didn't close.)
    const response = await fetch(`${COLIBRI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: COLIBRI_MODEL,
        messages,
        max_tokens: max_tokens || 4096,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      job.status = "error";
      job.error = `Colibri error ${response.status}: ${text.slice(0, 200)}`;
      log.warn(`job=${job.id} ${job.error}`);
      return;
    }

    // Parse SSE incrementally as chunks arrive (not buffer-then-parse-at-end)
    // so job.partialContent reflects real generation progress the whole time
    // a job is running — this is what check_colibri now reports for "still
    // running" jobs, and what survives if the connection dies mid-stream
    // (squid's client_lifetime cap, a network blip, etc.) instead of losing
    // an expensive, already-prefilled generation entirely.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = "";
    let usageData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? ""; // last element may be an incomplete line — keep it for next read

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            job.partialContent += delta.content;
            job.lastChunkAt = Date.now();
            job.chunkCount += 1;
          }
          if (chunk.usage) usageData = chunk.usage;
        } catch {
          // partial/malformed SSE line — skip it, don't fail the whole job over one chunk
        }
      }
    }

    const content = job.partialContent || "(empty response from colibri)";
    const usage = usageData
      ? ` [${usageData.prompt_tokens}+${usageData.completion_tokens}=${usageData.total_tokens} tokens]`
      : "";

    job.status = "done";
    job.result = content + usage;
    log.info(`<<< job=${job.id} ok  ${Date.now() - t0}ms${usage}  chunks=${job.chunkCount}`);
  } catch (err) {
    job.status = "error";
    const reason = err.name === "AbortError"
      ? `Colibri timed out after ${COLIBRI_TIMEOUT_MS / 1000}s`
      : `Colibri request failed: ${err.message}`;
    // Preserve whatever streamed in before the failure — an expensive,
    // already-prefilled generation shouldn't be a total loss just because
    // the connection died partway through decode.
    if (job.partialContent) {
      job.error = `${reason} (partial output preserved below, ${job.partialContent.length} chars generated before failure)`;
      job.result = job.partialContent;
    } else {
      job.error = reason;
    }
    log.warn(`job=${job.id} failed: ${reason}  partialChars=${job.partialContent.length}`);
  } finally {
    clearTimeout(timeout);
    job.finishedAt = Date.now();
  }
}

// --- Tool: check_colibri (poll) ---
const CHECK_TOOL_DESC = [
  "Check the status of a colibri query started with ask_colibri.",
  "Returns one of:",
  "  - still running — elapsed time plus live progress (chars generated so",
  "    far, chunks received, time since the last one). 'still in prefill' means",
  "    no output tokens yet; once chars are moving, decode has started.",
  "  - done (with the result text)",
  "  - error (with the failure reason). If the connection died mid-generation",
  "    after some output had already streamed, that partial text is included —",
  "    still worth relaying, it's not nothing.",
  "  - unknown job_id (typo, or the job aged out after 4h)",
].join("\n");

const CHECK_TOOL_PARAMS = {
  job_id: z.string().describe("The job_id returned by ask_colibri"),
};

async function handleCheckColibri({ job_id }) {
  const job = jobs.get(job_id);
  if (!job) {
    return {
      content: [{ type: "text", text: `Unknown job_id: ${job_id} (typo, or it aged out after ${JOB_RETENTION_MS / 3600000}h)` }],
      isError: true,
    };
  }

  if (job.status === "running") {
    const elapsedS = Math.round((Date.now() - job.createdAt) / 1000);
    const progress = job.chunkCount > 0
      ? `${job.partialContent.length} chars generated so far (${job.chunkCount} chunks, last one ${Math.round((Date.now() - job.lastChunkAt) / 1000)}s ago)`
      : `still in prefill — no output tokens yet`;
    return {
      content: [{ type: "text", text: `Still running (${elapsedS}s elapsed). ${progress}. Prompt: "${job.promptPreview}...". Check again in a minute or two.` }],
    };
  }

  if (job.status === "error") {
    const text = job.result
      ? `Failed: ${job.error}\n\n--- partial output ---\n${job.result}`
      : `Failed: ${job.error}`;
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }

  const totalS = Math.round((job.finishedAt - job.createdAt) / 1000);
  // Deliberately NOT marking delivered=true here: the agent seeing this
  // result via check_colibri doesn't guarantee it survives to reach the user
  // (e.g. the session-takeover failure mode this whole system exists to
  // guard against). Only the colibri-followup cron's confirmed WhatsApp send
  // marks a job delivered. Worst case on the happy path: a mild duplicate
  // message within the next 10 minutes, which beats a silently lost result.
  return {
    content: [{ type: "text", text: `Done (${totalS}s total).\n\n${job.result}` }],
  };
}

// --- Tool: list_colibri (list recent jobs) ---
const LIST_TOOL_DESC = [
  "List recent colibri jobs (from ask_colibri) and their status.",
  "Use this to see what's running/done/errored without already having a",
  "job_id — e.g. after a session gap, or to check whether an earlier ask is",
  "still in flight before firing another one.",
  "",
  "Returns id, status, elapsed/total time, prompt preview, and live progress",
  "for running jobs (same 'chars generated so far' signal as check_colibri).",
  "Sorted most-recent-first. Jobs age out of the list entirely after 4h",
  "(same retention as check_colibri).",
].join("\n");

const LIST_TOOL_PARAMS = {
  status: z.enum(["running", "done", "error", "all"]).optional()
    .describe("Filter by job status (default: all)"),
  limit: z.number().optional()
    .describe("Max jobs to return, most recent first (default: 20)"),
};

async function handleListColibri({ status, limit }) {
  const filterStatus = status && status !== "all" ? status : null;
  const max = limit && limit > 0 ? limit : 20;

  const all = [...jobs.values()]
    .filter(j => !filterStatus || j.status === filterStatus)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (!all.length) {
    return {
      content: [{ type: "text", text: filterStatus ? `No ${filterStatus} jobs.` : "No jobs (nothing asked yet, or everything aged out after 4h)." }],
    };
  }

  const shown = all.slice(0, max);
  const lines = shown.map(j => {
    const now = Date.now();
    let timing;
    if (j.status === "running") {
      timing = `${Math.round((now - j.createdAt) / 1000)}s elapsed`;
    } else {
      timing = `${Math.round((j.finishedAt - j.createdAt) / 1000)}s total`;
    }

    let extra = "";
    if (j.status === "running") {
      extra = j.chunkCount > 0
        ? ` — ${j.partialContent.length} chars so far, last chunk ${Math.round((now - j.lastChunkAt) / 1000)}s ago`
        : ` — still in prefill`;
    } else if (j.status === "error") {
      extra = ` — ${j.error}`;
    } else if (j.status === "done") {
      extra = j.delivered ? ` — delivered` : ` — not yet delivered`;
    }

    return `[${j.id}] ${j.status} (${timing})${extra}\n  prompt: "${j.promptPreview}..."`;
  });

  const header = `${shown.length}${all.length > shown.length ? `/${all.length}` : ""} job(s)${filterStatus ? ` (status=${filterStatus})` : ""}:`;
  return {
    content: [{ type: "text", text: `${header}\n\n${lines.join("\n\n")}` }],
  };
}

// Factory: each SSE connection gets its own McpServer (SDK enforces
// single-transport-per-instance — reusing one crashes on the second client).
// The `jobs` map above is module-level, so job_ids survive across
// reconnects and are visible from any session.
function createMcpServer() {
  const server = new McpServer({ name: "colibri-proxy", version: "2.0.0" });
  server.tool("ask_colibri", ASK_TOOL_DESC, ASK_TOOL_PARAMS, handleAskColibri);
  server.tool("check_colibri", CHECK_TOOL_DESC, CHECK_TOOL_PARAMS, handleCheckColibri);
  server.tool("list_colibri", LIST_TOOL_DESC, LIST_TOOL_PARAMS, handleListColibri);
  return server;
}

// --- HTTP server (SSE transport) ---
const transports = new Map();

const httpServer = http.createServer(async (req, res) => {
  log.debug(`${req.method} ${req.url}`);

  // GET /sse — new MCP client connection
  if (req.method === "GET" && req.url === "/sse") {
    log.info(`SSE connect`);
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => {
      log.info(`SSE disconnect  sessions=${transports.size - 1}`);
      transports.delete(transport.sessionId);
    });
    const server = createMcpServer();
    await server.connect(transport);
    return;
  }

  // POST /messages?sessionId=... — client JSON-RPC messages
  if (req.method === "POST" && req.url?.startsWith("/messages")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const sessionId = url.searchParams.get("sessionId");
    const transport = sessionId
      ? transports.get(sessionId)
      : [...transports.values()][0];
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("No active MCP session");
    }
    return;
  }

  // GET /pending — infra-only (not an MCP tool): completed-but-undelivered
  // jobs, for the colibri-followup cron job to push to WhatsApp. Includes
  // errored jobs that still captured partial output (connection died
  // mid-stream but generation had produced something) — better to deliver
  // "here's what colibri got through before it died" than silently drop it.
  if (req.method === "GET" && req.url === "/pending") {
    const pending = [...jobs.values()]
      .filter(j => !j.delivered && (j.status === "done" || (j.status === "error" && j.partialContent)))
      .map(j => ({
        id: j.id,
        promptPreview: j.promptPreview,
        result: j.result,
        partial: j.status === "error",
        error: j.status === "error" ? j.error : undefined,
        finishedAt: j.finishedAt,
      }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(pending));
    return;
  }

  // POST /pending/:id/ack — mark a job as delivered (only after a confirmed send)
  if (req.method === "POST" && req.url?.match(/^\/pending\/[^/]+\/ack$/)) {
    const id = req.url.split("/")[2];
    const job = jobs.get(id);
    if (!job) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Unknown job_id");
      return;
    }
    job.delivered = true;
    log.info(`job=${id} acked as delivered`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /health — docker healthcheck + operator debug
  if (req.method === "GET" && req.url === "/health") {
    const running = [...jobs.values()].filter(j => j.status === "running").length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      model: COLIBRI_MODEL,
      base_url: COLIBRI_BASE_URL,
      timeout_s: COLIBRI_TIMEOUT_MS / 1000,
      active_sessions: transports.size,
      jobs_total: jobs.size,
      jobs_running: running,
    }));
    return;
  }

  // Anything else — 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.error(`[mcp-colibri] SSE transport listening on :${PORT}/sse`);
  console.error(`[mcp-colibri] Health check at :${PORT}/health`);
  console.error(`[mcp-colibri] Colibri: ${COLIBRI_BASE_URL} model=${COLIBRI_MODEL}`);
  console.error(`[mcp-colibri] Timeout: ${COLIBRI_TIMEOUT_MS / 1000}s`);
  console.error(`[mcp-colibri] Job retention: ${JOB_RETENTION_MS / 3600000}h`);
  console.error(`[mcp-colibri] LOG_LEVEL: ${LOG_LEVEL}`);
  console.error(`[mcp-colibri] tools: ask_colibri (fire), check_colibri (poll), list_colibri (list)`);
});
