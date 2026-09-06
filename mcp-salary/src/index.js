// mcp-salary — MCP tool server for salary research.
//
// Exposes two SYNCHRONOUS tools (unlike colibri's fire-and-poll — these are
// plain HTTPS fetches, seconds not minutes):
//
//   salary_bls        — official Bureau of Labor Statistics OEWS wage data
//                       (occupational medians/percentiles, national or per
//                       metro area). The only numbers-source in this server
//                       that is verified to work server-side: no auth, no
//                       anti-bot, documented public API.
//   salary_levels_fyi — deep links into levels.fyi for a company/title.
//                       levels.fyi has NO public API (verified 2026-09: all
//                       unauthenticated data endpoints 404; salary tables
//                       load client-side from a private backend), so this
//                       tool returns links for the user to open — it does
//                       NOT pretend to return numbers.
//
// Glassdoor/Blind are deliberately not tools at all: aggressively
// anti-bot (Cloudflare), not fetchable from a squid allowlist proxy, and
// scraping them would violate their ToS.
//
// Transport: SSE over HTTP, same pattern as mcp-colibri. Egress goes through
// the squid allowlist proxy (forced by HTTP_PROXY env var).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "node:http";

const BLS_API = process.env.BLS_API_URL || "https://api.bls.gov/publicAPI/v1/timeseries/data/";
const PORT = parseInt(process.env.PORT || "3000", 10);
const LOG_LEVEL = process.env.LOG_LEVEL || "warn";
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || "20000", 10);

const log = {
  debug: (...args) => LOG_LEVEL === "debug" && console.error("[DEBUG]", ...args),
  info: (...args) => ["debug", "info"].includes(LOG_LEVEL) && console.error("[INFO]", ...args),
  warn: (...args) => console.error("[WARN]", ...args),
};

// --- BLS OEWS series construction ---
// Series ID layout (verified against download.bls.gov/pub/time.series/oe/oe.txt,
// 2026-09):
//   OE + seasonal(1) + areatype(1) + area_code(7) + industry_code(6)
//     + occupation_code(6) + datatype_code(2)
// The areatype letter depends on the AREA, not on user preference (all three
// verified live 2026-09):
//   OEUN — national (area 0000000)
//   OEUS — state (area = state FIPS + 00000, e.g. 0600000 California)
//   OEUM — metro (area = state FIPS + 5-digit metro, e.g. 0031080 LA)
const NATIONAL_AREA = "0000000";
const ALL_INDUSTRIES = "000000";

function areaTypePrefix(areaCode) {
  if (areaCode === NATIONAL_AREA) return "OEUN";
  if (areaCode.endsWith("00000")) return "OEUS";
  return "OEUM";
}

// Datatype codes from download.bls.gov/pub/time.series/oe/oe.datatype
const ANNUAL_DATATYPES = {
  "01": "employment (count)",
  "04": "annual mean wage",
  "11": "annual 10th pct",
  "12": "annual 25th pct",
  "13": "annual MEDIAN wage",
  "14": "annual 75th pct",
  "15": "annual 90th pct",
};
const HOURLY_DATATYPES = {
  "03": "hourly mean wage",
  "06": "hourly 10th pct",
  "07": "hourly 25th pct",
  "08": "hourly MEDIAN wage",
  "09": "hourly 75th pct",
  "10": "hourly 90th pct",
};

// Common SOC codes for tech/esports-adjacent roles — the agent should map a
// job title to one of these before calling salary_bls (BLS indexes by SOC,
// not by title).
const COMMON_SOC = {
  "15-1252": "Software Developers",
  "15-1251": "Computer Programmers",
  "15-1254": "Web Developers",
  "15-1244": "Network and Computer Systems Administrators",
  "15-1245": "Database Architects",
  "15-1241": "Computer Network Architects",
  "15-1211": "Computer Systems Analysts",
  "11-3021": "Computer and Information Systems Managers",
  "11-9041": "Architectural and Engineering Managers",
  "13-1082": "Project Management Specialists",
  "13-1161": "Market Research Analysts",
  "11-2021": "Marketing Managers",
  "27-4032": "Film and Video Editors",
};

function normalizeSoc(soc) {
  const digits = String(soc).replace(/[^0-9]/g, "");
  if (digits.length !== 6) {
    throw new Error(`SOC code must be 6 digits (e.g. "15-1252" or "151252"), got "${soc}"`);
  }
  return digits;
}

function buildSeriesIds(soc6, areaCode, includeHourly) {
  const head = `${areaTypePrefix(areaCode)}${areaCode}${ALL_INDUSTRIES}${soc6}`;
  const datatypes = includeHourly
    ? { ...ANNUAL_DATATYPES, ...HOURLY_DATATYPES }
    : ANNUAL_DATATYPES;
  return Object.keys(datatypes).map(dt => ({
    seriesId: head + dt,
    datatype: dt,
    label: datatypes[dt],
  }));
}

async function fetchBls(seriesIds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    // v1 POST: up to 25 series, no API key needed at this volume
    const res = await fetch(BLS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesid: seriesIds.map(s => s.seriesId) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BLS HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function formatUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return `$${n.toLocaleString("en-US")}`;
}

async function handleSalaryBls({ soc_code, area_code, include_hourly, occupation_hint }) {
  let soc6;
  try {
    soc6 = normalizeSoc(soc_code);
  } catch (e) {
    // Fail helpfully: suggest the common codes rather than a bare format error
    const suggestions = Object.entries(COMMON_SOC)
      .map(([code, name]) => `  ${code}  ${name}`)
      .join("\n");
    return {
      content: [{
        type: "text",
        text: `${e.message}\n\nCommon SOC codes (pass as soc_code):\n${suggestions}\n\nFull index: https://www.bls.gov/soc/2018/soc_crosswalk.htm`,
      }],
      isError: true,
    };
  }

  const area = area_code ? String(area_code).padStart(7, "0") : NATIONAL_AREA;
  if (!/^\d{7}$/.test(area)) {
    return {
      content: [{ type: "text", text: `area_code must be 7 digits, got "${area_code}". Omit for national data. Metro codes: https://download.bls.gov/pub/time.series/oe/oe.area` }],
      isError: true,
    };
  }

  const wanted = buildSeriesIds(soc6, area, !!include_hourly);
  log.info(`salary_bls soc=${soc6} area=${area} series=${wanted.length}`);

  let payload;
  try {
    payload = await fetchBls(wanted);
  } catch (e) {
    return {
      content: [{ type: "text", text: `BLS request failed: ${e.message}` }],
      isError: true,
    };
  }

  if (payload.status !== "REQUEST_SUCCEEDED") {
    return {
      content: [{ type: "text", text: `BLS status: ${payload.status}. ${JSON.stringify(payload.message || []).slice(0, 300)}` }],
      isError: true,
    };
  }

  const byId = new Map(wanted.map(s => [s.seriesId, s]));
  const rows = [];
  const missing = [];
  let latestYear = 0;
  for (const series of payload.Results?.series || []) {
    const meta = byId.get(series.seriesID);
    const datapoints = (series.data || []).filter(d => d.period === "A01" || d.period?.startsWith("M"));
    if (!meta || !datapoints.length) {
      if (meta) missing.push(meta.label);
      continue;
    }
    // Take the most recent year present (OEWS publishes one survey per year)
    const sorted = datapoints.sort((a, b) => Number(b.year) - Number(a.year));
    const latest = sorted[0];
    latestYear = Math.max(latestYear, Number(latest.year));
    rows.push({ label: meta.label, year: latest.year, value: latest.value, footnotes: latest.footnotes?.map(f => f.note).filter(Boolean) });
  }

  if (!rows.length) {
    return {
      content: [{
        type: "text",
        text: `No OEWS data for SOC ${soc_code} in area ${area}. The occupation code may be valid for BLS but absent from the OEWS survey (covers wage/salary occupations), or the area code is wrong. Metro area codes: https://download.bls.gov/pub/time.series/oe/oe.area`,
      }],
      isError: true,
    };
  }

  // Median-first ordering: it's the number people actually want
  rows.sort((a, b) => {
    const rank = r => (r.label.includes("MEDIAN") ? 0 : r.label.startsWith("annual mean") || r.label.startsWith("hourly mean") ? 1 : r.label.startsWith("employment") ? 2 : 3);
    return rank(a) - rank(b);
  });

  const socName = occupation_hint || Object.entries(COMMON_SOC).find(([c]) => c.replace("-", "") === soc6)?.[1] || `SOC ${soc_code}`;
  const scope = area === NATIONAL_AREA ? "United States, all industries" : `BLS area ${area}`;
  const lines = rows.map(r => `- **${r.label}** (${r.year}): ${r.label.startsWith("employment") ? r.value : formatUsd(r.value)}`);

  return {
    content: [{
      type: "text",
      text: [
        `**BLS OEWS — ${socName}** (${scope})`,
        ``,
        ...lines,
        ``,
        `Source: BLS Occupational Employment and Wage Statistics (api.bls.gov, public domain).`,
        area !== NATIONAL_AREA ? `Metro area codes: https://download.bls.gov/pub/time.series/oe/oe.area` : ``,
        `Survey-based: excludes self-employed; "wage" = base pay only (no bonus/equity — for total comp, see salary_levels_fyi links).`,
      ].filter(Boolean).join("\n"),
    }],
  };
}

// --- levels.fyi deep links ---
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function handleSalaryLevelsFyi({ company, title, location }) {
  if (!company) {
    return {
      content: [{ type: "text", text: "company is required (e.g. \"Riot Games\")" }],
      isError: true,
    };
  }

  const links = [];
  // Direct company page (levels.fyi slugs are lowercase-hyphenated; /company/X
  // 301s to the canonical slug when X isn't exact, so an imperfect slug still lands right)
  links.push(`- Company total-comp data: https://www.levels.fyi/company/${slugify(company)}`);
  if (title) {
    links.push(location
      ? `- ${title} in ${location}: https://www.levels.fyi/t/${slugify(title)}/locations/${slugify(location)}`
      : `- ${title} (all locations): https://www.levels.fyi/t/${slugify(title)}`);
  }
  links.push(`- Free-text search: https://www.levels.fyi/search?query=${encodeURIComponent([company, title].filter(Boolean).join(" "))}`);

  return {
    content: [{
      type: "text",
      text: [
        `**levels.fyi links for ${company}${title ? ` — ${title}` : ""}:**`,
        ``,
        ...links,
        ``,
        `IMPORTANT: levels.fyi has no public API — their salary tables load from a private,`,
        `authenticated backend, so I cannot fetch the numbers server-side (verified 2026-09).`,
        `Open the links in a browser to read actual medians/percentiles. These are TOTAL`,
        `compensation figures (base + stock + bonus) from self-reported data — richer than`,
        `BLS base-wage data but with volunteer-sample bias. Pair them: BLS for trustworthy`,
        `base-wage floor, levels.fyi for realistic total-comp expectations.`,
      ].join("\n"),
    }],
  };
}

// --- Server wiring (same SSE pattern as mcp-colibri) ---

const BLS_TOOL_DESC = [
  "Official US Bureau of Labor Statistics (BLS OEWS) wage data for an occupation:",
  "median, mean, 10th-90th percentile annual (and optionally hourly) wages,",
  "plus employment count. National by default; pass area_code for a metro.",
  "",
  "REQUIRES a 6-digit SOC code (e.g. \"15-1252\"), NOT a job title — map the",
  "title first (the error message lists common tech/esports-adjacent codes).",
  "",
  "Use for: trustworthy, official base-wage data. Survey-based, public domain.",
  "Limitation: base pay only — no bonus/equity; self-reported levels.fyi total",
  "comp is the complement (see salary_levels_fyi).",
].join("\n");

const BLS_TOOL_PARAMS = {
  soc_code: z.string().describe('6-digit SOC code, e.g. "15-1252" (Software Developers) or "13-1082" (Project Management Specialists)'),
  area_code: z.string().optional().describe("Optional 7-digit BLS area code for metro data (e.g. \"0031080\"); omit for national. Codes: https://download.bls.gov/pub/time.series/oe/oe.area"),
  include_hourly: z.boolean().optional().describe("Also return hourly percentiles (useful for broadcast/event-production roles)"),
  occupation_hint: z.string().optional().describe("Human-readable occupation name to label the result (optional)"),
};

const LEVELS_TOOL_DESC = [
  "Build deep links into levels.fyi (total-compensation crowdsourcing site) for",
  "a company and optionally a title/location. Returns URLs for the USER to open",
  "in a browser.",
  "",
  "Does NOT return salary numbers: levels.fyi has no public API (their tables",
  "load from a private authenticated backend — verified 2026-09). Be upfront",
  "with the user about this; do not claim to have fetched figures.",
  "",
  "Pair with salary_bls: BLS gives official base-wage data; levels.fyi gives",
  "realistic total-comp (base+stock+bonus) with self-report bias.",
].join("\n");

const LEVELS_TOOL_PARAMS = {
  company: z.string().describe("Company name, e.g. \"Riot Games\""),
  title: z.string().optional().describe("Job title, e.g. \"Technical Program Manager\""),
  location: z.string().optional().describe("Location slug, e.g. \"Los Angeles\" (requires title)"),
};

function createMcpServer() {
  const server = new McpServer({ name: "salary", version: "1.0.0" });
  server.tool("salary_bls", BLS_TOOL_DESC, BLS_TOOL_PARAMS, handleSalaryBls);
  server.tool("salary_levels_fyi", LEVELS_TOOL_DESC, LEVELS_TOOL_PARAMS, handleSalaryLevelsFyi);
  return server;
}

const transports = new Map();

const httpServer = http.createServer(async (req, res) => {
  log.debug(`${req.method} ${req.url}`);

  if (req.method === "GET" && req.url === "/sse") {
    log.info("SSE connect");
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => {
      transports.delete(transport.sessionId);
    });
    const server = createMcpServer();
    await server.connect(transport);
    return;
  }

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

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      bls_api: BLS_API,
      active_sessions: transports.size,
      allowlisted_egress: "api.bls.gov (via squid)",
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.error(`[mcp-salary] SSE transport listening on :${PORT}/sse`);
  console.error(`[mcp-salary] Health check at :${PORT}/health`);
  console.error(`[mcp-salary] BLS API: ${BLS_API}`);
  console.error(`[mcp-salary] tools: salary_bls (official OEWS wages), salary_levels_fyi (deep links, no numbers)`);
});
