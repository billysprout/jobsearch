// mcp-jobscrape — MCP tool server for agent-driven jobscrape configuration.
//
// The user is non-technical; the AGENT is the configuration UX. A user says
// "stop showing me Riot jobs" or "only recent postings, and more of them" in
// their usual chat, and the agent maps that intent onto the tools below.
// Every tool is a thin proxy to the host-side config-server.mjs
// (jobscrape/config-server.mjs, token-gated), which validates each change
// through the same config validator the scraper itself uses, snapshots the
// previous config, and writes atomically. The tool response's `note` field is
// written in plain language — relay it to the user rather than re-explaining.
//
// Transport: SSE over HTTP, same pattern as mcp-salary/mcp-colibri. Reaches
// the jobscrape-config container directly on the dedicated internal jobscrape
// network (NO_PROXY peer — no proxy, no host access involved). The gateway
// has no route to that network: this container's curated tools are the only
// configuration path.
//
// Security: this container can CHANGE what the user's job scraper does. The
// token is the only thing standing between a prompt-injected agent turn and
// the user's config — never log it, and never pass config-affecting tool
// calls through without the user having asked for the change.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "node:http";

const CONFIG_URL = process.env.JOBSCRAPE_CONFIG_URL || "http://jobscrape-config:8790";
const TOKEN = process.env.JOBSCRAPE_CONFIG_TOKEN || "";
const PORT = parseInt(process.env.PORT || "3000", 10);
const LOG_LEVEL = process.env.LOG_LEVEL || "warn";

const log = {
  debug: (...args) => LOG_LEVEL === "debug" && console.error("[DEBUG]", ...args),
  info: (...args) => ["debug", "info"].includes(LOG_LEVEL) && console.error("[INFO]", ...args),
  warn: (...args) => console.error("[WARN]", ...args),
};

if (!TOKEN) {
  console.error("[mcp-jobscrape] FATAL: JOBSCRAPE_CONFIG_TOKEN is not set — refusing to start");
  process.exit(1);
}

// --- host service client -----------------------------------------------------

async function hostRequest(method, p, body) {
  const res = await fetch(`${CONFIG_URL}${p}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000), // local service — 15s is generous
  });
  const text = await res.text();
  if (!res.ok) {
    // The host service's 400s carry validator/action messages meant for the
    // agent to relay or self-correct — surface them verbatim.
    throw new Error(`config service said ${res.status}: ${text.slice(0, 400)}`);
  }
  return text;
}

const hostAction = (action, params) => hostRequest("POST", "/action", { action, params });

// --- the walkthrough (jobscrape_help) -----------------------------------------

const HELP_TEXT = [
  "You are helping a non-technical user configure their daily job scraper.",
  "General approach:",
  "1. Ask what they want in plain words. Map intent to ONE tool call at a time.",
  '   - "stop showing me <Company>"           -> jobscrape_block_company',
  '   - "don\'t show <kind of role> roles"     -> jobscrape_block_title_pattern',
  '   - "only recent postings" / "last N days"-> jobscrape_set_recency_days',
  '   - "show postings of any age"            -> jobscrape_set_recency_off',
  '   - "more/fewer jobs per day"             -> jobscrape_set_daily_limit (1-40)',
  '   - "don\'t let one company dominate"      -> jobscrape_set_per_company_max',
  '   - "I don\'t care about board X"          -> jobscrape_toggle_source',
  '   - "add <Company>"                       -> jobscrape_add_watched_company —',
  '     FIRST confirm the ATS slug with the user (it is the URL path segment on',
  '     the company\'s job board, e.g. riotgames in greenhouse.io/riotgames).',
  '     A wrong slug silently watches the WRONG company. Ask them to paste the',
  '     board URL, or look at jobscrape_get_config watchedCompanies for context.',
  '   - "what do I currently have set up?"    -> jobscrape_get_config + summarize',
  '   - "undo that"                           -> jobscrape_list_backups, then',
  '     jobscrape_restore_backup with the newest snapshot',
  "2. Every tool response contains a `note` in plain language — repeat it to the",
  "   user almost verbatim. It already mentions side effects.",
  "3. Track edits (keywords/labels) change the ranking model's prompt: the next",
  "   run is slower ONCE while the model re-learns it. Say so when it happens.",
  "4. Confirm before destructive or broad changes (blocking a company, big",
  "   keyword rewrites). Never chain several config changes in one turn without",
  "   the user having asked for each of them.",
  "5. jobscrape_get_status shows what today's digest looks like — use it to show",
  "   the user the effect of their change on the NEXT run.",
].join("\n");

// --- tool descriptions (the conversational contract) --------------------------

const desc = (...lines) => lines.join("\n");

const TOOL_DEFS = [
  ["jobscrape_help", "How to help the user configure their job scraper conversationally. Start here when the user asks about jobs/settings/digests in general terms.", {},
    () => HELP_TEXT],

  ["jobscrape_get_config", "Read the user's current job-scraper configuration (tracks + keywords, blocked companies/patterns, recency, per-run limits, enabled boards, watched companies). Summarize in plain words; never dump raw JSON at the user.", {},
    async () => hostRequest("GET", "/config")],

  ["jobscrape_get_status", "Read today's scrape status: what got ranked into today's digest, how many postings are waiting for the ranking model, how many seen all-time. Use to show the user the state of things.", {},
    async () => hostRequest("GET", "/status")],

  ["jobscrape_set_track_keywords", desc(
    "Replace the keyword list of a job track (the themes the user tracks).",
    "CONFIRM with the user first: read the current list via jobscrape_get_config and",
    "show it. Warn: the next run is slower once (ranking model re-learns its prompt).",
    "The error message lists valid track names if you guess wrong.",
  ), {
    track: z.string().describe("Track key, e.g. 'producer_pm'"),
    keywords: z.array(z.string()).min(1).describe("Replacement keyword list, e.g. ['technical program manager', 'tpm']"),
  }, p => hostAction("set_track_keywords", p)],

  ["jobscrape_set_track_weight", "Set how strongly a track's keyword hits score (higher = that track ranks postings up more aggressively). 0 < weight <= 10.", {
    track: z.string().describe("Track key"),
    weight: z.number().describe("New weight (0 < w <= 10)"),
  }, p => hostAction("set_track_weight", p)],

  ["jobscrape_set_track_label", "Rename how a track is displayed in digests and push notifications.", {
    track: z.string().describe("Track key"),
    label: z.string().describe("New display name, e.g. 'Producer / PM'"),
  }, p => hostAction("set_track_label", p)],

  ["jobscrape_block_company", desc(
    "Never show a company's postings again. CONFIRM the exact company name with the",
    "user first — blocking is the strongest 'make this go away'.",
  ), {
    company: z.string().describe("Company name exactly as it should be blocked, e.g. 'Acme Corp'"),
  }, p => hostAction("block_company", p)],

  ["jobscrape_unblock_company", "Show a blocked company's postings again.", {
    company: z.string().describe("Company name to unblock (case-insensitive)"),
  }, p => hostAction("unblock_company", p)],

  ["jobscrape_block_title_pattern", desc(
    "Hide postings whose TITLE matches a regular expression, e.g. 'senior' to hide",
    "seniority the user does not want. Plain words usually work ('hide anything with",
    "the word senior in the title'). Invalid regexes are rejected by the service.",
  ), {
    pattern: z.string().describe("Regular expression matched case-insensitively against the title"),
  }, p => hostAction("block_title_pattern", p)],

  ["jobscrape_unblock_title_pattern", "Stop hiding titles that match a previously set pattern (exact string as originally set).", {
    pattern: z.string().describe("The exact pattern string to remove"),
  }, p => hostAction("unblock_title_pattern", p)],

  ["jobscrape_set_recency_days", "Only show postings from the last N days (1-365). Suggest 30 if the user says 'only recent stuff'.", {
    days: z.number().int().describe("How many days back to include"),
  }, p => hostAction("set_recency_days", p)],

  ["jobscrape_set_recency_off", "Turn recency filtering off — postings of any age can appear again.", {},
    p => hostAction("set_recency_off", p)],

  ["jobscrape_set_daily_limit", desc(
    "How many postings get fully ranked per daily run (1-40). Higher = more results",
    "but much longer runs (each posting takes the local model minutes). 10 is the",
    "deliberate production default — confirm the user understands the slowdown.",
  ), {
    limit: z.number().int().describe("New per-run limit (1-40)"),
  }, p => hostAction("set_daily_limit", p)],

  ["jobscrape_set_reserved_slots", "Reserve N slots (0-9) per run for generic job boards so big companies can't crowd them out entirely.", {
    slots: z.number().int().describe("Slots reserved for non-curated sources (0 = off)"),
  }, p => hostAction("set_reserved_slots", p)],

  ["jobscrape_set_per_company_max", "At most N postings from the same company per run (1-10).", {
    max: z.number().int().describe("Max postings per company per run"),
  }, p => hostAction("set_per_company_max", p)],

  ["jobscrape_toggle_source", desc(
    "Enable/disable a job board (e.g. remoteok, remotive, hn). Valid names come from",
    "jobscrape_get_config's sources map.",
  ), {
    source: z.string().describe("Board name"),
    enabled: z.boolean().describe("true = enable, false = disable"),
  }, p => hostAction("toggle_source", p)],

  ["jobscrape_add_watched_company", desc(
    "Watch a company's own job board (their ATS feed). VERIFY THE SLUG FIRST: it is",
    "the URL path segment of the company's board (riotgames in",
    "boards.greenhouse.io/riotgames). A wrong slug silently watches the WRONG",
    "company — ask the user to paste the board URL. Note: 'lever' boards are",
    "disabled repo-wide; prefer greenhouse/workable/ashby.",
  ), {
    ats: z.enum(["greenhouse", "workable", "ashby", "lever"]).describe("Which ATS the company uses"),
    slug: z.string().describe("Board URL path segment"),
    label: z.string().describe("Company display name"),
  }, p => hostAction("add_watched_company", p)],

  ["jobscrape_remove_watched_company", "Stop watching a company's job board.", {
    ats: z.enum(["greenhouse", "workable", "ashby", "lever"]).describe("Which ATS"),
    slug: z.string().describe("Board slug to remove"),
  }, p => hostAction("remove_watched_company", p)],

  ["jobscrape_list_backups", "List configuration snapshots (restore points). Newer names first.", {},
    p => hostAction("list_backups", p)],

  ["jobscrape_restore_backup", desc(
    "Restore the configuration from a snapshot (use after a mistake, e.g. the user",
    "says 'undo that'). Confirm which snapshot when several exist.",
  ), {
    file: z.string().describe("Snapshot file name from jobscrape_list_backups"),
  }, p => hostAction("restore_backup", p)],
];

// --- server wiring (same SSE pattern as mcp-salary) ---------------------------

function createMcpServer() {
  const server = new McpServer({ name: "jobscrape", version: "1.0.0" });
  for (const [name, description, params, handler] of TOOL_DEFS) {
    server.tool(name, description, params, async args => {
      try {
        const text = await handler(args);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        log.warn(`${name} failed: ${e.message}`);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    });
  }
  return server;
}

const server = createMcpServer();
const transports = new Map();

const httpServer = http.createServer(async (req, res) => {
  log.debug(`${req.method} ${req.url}`);

  if (req.method === "GET" && req.url === "/sse") {
    log.info("SSE connect");
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => { transports.delete(transport.sessionId); });
    await server.connect(transport);
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/messages")) {
    const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      await transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end("No active MCP session");
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return void res.end(JSON.stringify({ ok: true, service: "mcp-jobscrape", active_sessions: transports.size }));
  }

  res.writeHead(404).end();
});

httpServer.listen(PORT, () => {
  console.error(`[mcp-jobscrape] SSE transport listening on :${PORT}/sse`);
  console.error(`[mcp-jobscrape] Health check at :${PORT}/health`);
  console.error(`[mcp-jobscrape] Config service: ${CONFIG_URL}`);
});
