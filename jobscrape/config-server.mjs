// config-server.mjs — host-side config/status service for jobscrape.
//
// Serves two audiences:
//   1. agents (the OpenClaw agent via mcp-jobscrape) applying config changes
//      through POST /action, and
//   2. a browser status page (GET /) whose gemma-backed chat box turns plain
//      English into the same validated action calls (POST /chat) — so the
//      friend kit is configurable without any agent installed.
//
// Security model (see SECURITY-REVIEW.md):
//   - Binds 0.0.0.0 — it MUST be reachable from containers via Docker's
//     host-gateway (same reason colibri itself binds wide). Nothing is
//     published to the LAN by this repo; exposure is whatever the Windows
//     firewall allows for the port.
//   - Every route except GET /health requires the bearer token from
//     JOBSCRAPE_CONFIG_TOKEN (constant-time compare, fail-closed: no token
//     configured = the service refuses to start). Browsers may pass it as
//     ?token= — the page's chat can apply config actions, gated by the same
//     token (loopback-only publish in docker-compose.yml).
//
// Write model:
//   - Actions mutate ONLY configs/base.json (content maps: tracks, sources,
//     ats) and the ACTIVE PROFILE file (tuning knobs: filters' config,
//     selection) — the exact two layers the 07:00 task loads. The profile
//     file is production.json on the sandbox, friend.json in the kit.
//   - Every write first validates the merged result through config.mjs's own
//     validateConfig; a rejection changes nothing on disk.
//   - Every write snapshots BOTH files into configs/.backups/ and appends an
//     audit line. restore_backup is the "undo what we just did" path.
//   - scrape.mjs reads config once at startup: an edit made mid-run applies
//     on the NEXT run. No locking, no live reload — by design.
//
// Deliberately NOT exposed: colibri.generation.* and prompt-affecting knobs
// (changing them costs a full KV-cache re-prefill of the local model), and
// anything outside the curated action table below.
//
// Usage:  node config-server.mjs            (env: JOBSCRAPE_CONFIG_PORT,
//                                            JOBSCRAPE_CONFIG_TOKEN)
// Test:   import { createConfigServer } and listen on an ephemeral port.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { DEFAULTS, deepMerge, applyLegacyAliases, validateConfig, loadConfig, ConfigError } from "./config.mjs";
import { loadSeen, loadPendingQueue, loadTodayRankings } from "./state.mjs";
import { renderSummaryJson } from "./pipeline/render.mjs";

const PORT = parseInt(process.env.JOBSCRAPE_CONFIG_PORT || "8790", 10);
const TOKEN = process.env.JOBSCRAPE_CONFIG_TOKEN || "";
const MAX_BODY_BYTES = 1024 * 1024;
const ATS_FAMILIES = ["greenhouse", "workable", "ashby", "lever"];
const MAX_DAILY_LIMIT = 40; // DEFAULTS.selection.limit — colibri is 1-10+ min/posting

// The status-page chat brain: the SAME gemma install the scraper ranks with
// (the kit always creates gemma4-e2b-64k). On Docker Desktop
// host.docker.internal is built in; colima needs the host-gateway
// extra_host in docker-compose.yml (jobscrape-config has it too).
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://host.docker.internal:11434").replace(/\/+$/, "");
const CHAT_MODEL = process.env.JOBSCRAPE_CHAT_MODEL || "gemma4-e2b-64k";
const CHAT_TIMEOUT_MS = 120000;

// --- helpers ---------------------------------------------------------------

const nowStamp = () => new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");

function json(res, code, obj) {
  // Defensive: an error path firing after the response head is already out
  // (e.g. a handler that wrote 200 then threw mid-body) must end the
  // response, not double-writeHead and crash the whole server. Live-proven
  // 2026-09-08: a fresh install with no configs/production.json did exactly
  // that via the GET / error path.
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest();
}

function authorized(req, url, token) {
  const header = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const candidate = header || url.searchParams.get("token") || "";
  if (!candidate) return false;
  return timingSafeEqual(sha256(candidate), sha256(token)); // constant-time
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Atomic on both POSIX and Windows: same-dir tmp + rename.
function writeJsonFile(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// Merged + validated view of exactly what the daily task would load. The
// profile follows the scraper's (JOBSCRAPE_PROFILE, default "production")
// — a standalone kit machine has no production.json and runs profile
// "friend"; hardcoding production here 500'd every status view there.
function mergedConfig(configDir) {
  return loadConfig({ dir: configDir, profile: process.env.JOBSCRAPE_PROFILE || "production" });
}

function readLayers(configDir) {
  // The "tuning layer" is the ACTIVE PROFILE file, not always production.json:
  // loadConfig merges base.json + configs/<JOBSCRAPE_PROFILE>.json, and the
  // kit runs profile "friend". Writing tuning knobs to a fixed production.json
  // made every block/keyword/limit change a silent no-op on kit machines —
  // the scraper never loaded the file (live-probed 2026-09-09: "block Acme
  // Corp" answered ok, landed in production.json, blocked nothing). On the
  // sandbox profile=production, so this resolves exactly as before.
  const profile = process.env.JOBSCRAPE_PROFILE || "production";
  const tuning = profile === "base" ? "production" : profile; // profile "base" = no tuning file; keep writes off base.json
  const baseFile = path.join(configDir, "configs", "base.json");
  const prodFile = path.join(configDir, "configs", `${tuning}.json`);
  return {
    baseFile,
    prodFile,
    base: readJsonFile(baseFile),
    production: fs.existsSync(prodFile) ? readJsonFile(prodFile) : {},
  };
}

function validateLayers(configDir, { base, production }) {
  let cfg = deepMerge(structuredClone(DEFAULTS), applyLegacyAliases(structuredClone(base)));
  cfg = deepMerge(cfg, applyLegacyAliases(structuredClone(production)));
  return validateConfig(cfg);
}

// --- the curated action table ----------------------------------------------
// Each action mutates the raw base/production layers in place and returns an
// optional plain-language note for the agent to relay. Everything each action
// can touch is in this file — nothing dynamic decides what gets written.

// Ensure an opt-in filter stage is actually in the production chain — a
// blocklist entry with no blocklist stage in `filters` would silently do
// nothing.
function ensureFilter(production, name) {
  if (!Array.isArray(production.filters)) production.filters = ["keyword-match"];
  if (!production.filters.includes(name)) production.filters.push(name);
}

function requireTrack(live, track) {
  if (!track || typeof track !== "string" || !live.tracks[track]) {
    throw new ConfigError(`unknown track "${track}" — known tracks: ${Object.keys(live.tracks).join(", ")}`);
  }
}

const ACTIONS = {
  set_track_keywords: {
    summary: "replace a track's keyword list (what matching is based on)",
    apply(params, layers, live) {
      requireTrack(live, params.track);
      const kw = params.keywords;
      if (!Array.isArray(kw) || !kw.length || kw.some(k => typeof k !== "string" || !k.trim())) {
        throw new ConfigError("keywords must be a non-empty array of non-empty strings");
      }
      const unique = [...new Set(kw.map(k => k.trim()))];
      (layers.base.tracks ||= {})[params.track].keywords = unique;
      return `keywords for "${live.tracks[params.track].label}" are now: ${unique.join(", ")}. Track edits change the colibri prompt — the first ranking call after this may be slower (prompt re-cache).`;
    },
  },
  set_track_weight: {
    summary: "set how strongly a track's keyword hits score",
    apply(params, layers, live) {
      requireTrack(live, params.track);
      const w = Number(params.weight);
      if (!Number.isFinite(w) || w <= 0 || w > 10) throw new ConfigError("weight must be a number > 0 and <= 10");
      (layers.base.tracks ||= {})[params.track].weight = w;
      return `weight of "${live.tracks[params.track].label}" set to ${w}.`;
    },
  },
  set_track_label: {
    summary: "rename how a track is displayed",
    apply(params, layers, live) {
      requireTrack(live, params.track);
      if (typeof params.label !== "string" || !params.label.trim()) throw new ConfigError("label must be a non-empty string");
      (layers.base.tracks ||= {})[params.track].label = params.label.trim();
      return `track now displays as "${params.label.trim()}". Track edits change the colibri prompt — the first ranking call after this may be slower.`;
    },
  },
  block_company: {
    summary: "never show a company's postings again",
    apply(params, layers, live) {
      const company = String(params.company || "").trim();
      if (!company) throw new ConfigError("company is required");
      ensureFilter(layers.production, "blocklist");
      const bl = ((layers.production.filterConfig ||= {}).blocklist ||= { companies: [], titlePatterns: [] });
      bl.companies ||= [];
      if (!bl.companies.some(c => c.toLowerCase() === company.toLowerCase())) bl.companies.push(company);
      return `"${company}" is blocked — their postings will no longer appear in digests.`;
    },
  },
  unblock_company: {
    summary: "show a company's postings again",
    apply(params, layers) {
      const company = String(params.company || "").trim();
      if (!company) throw new ConfigError("company is required");
      const bl = layers.production?.filterConfig?.blocklist;
      if (!bl?.companies?.length) throw new ConfigError("the blocklist is empty — nothing to unblock");
      const before = bl.companies.length;
      bl.companies = bl.companies.filter(c => c.toLowerCase() !== company.toLowerCase());
      if (bl.companies.length === before) {
        throw new ConfigError(`"${company}" is not blocked — blocked companies: ${bl.companies.join(", ")}`);
      }
      return `"${company}" unblocked — their postings can appear again.`;
    },
  },
  unblock_title_pattern: {
    summary: "stop hiding titles that match a pattern",
    apply(params, layers) {
      const pattern = String(params.pattern || "").trim();
      const bl = layers.production?.filterConfig?.blocklist;
      if (!bl?.titlePatterns?.includes(pattern)) {
        throw new ConfigError(`pattern not found — active patterns: ${(bl?.titlePatterns || []).join(", ") || "none"}`);
      }
      bl.titlePatterns = bl.titlePatterns.filter(p => p !== pattern);
      return `pattern /${pattern}/i removed — matching titles can appear again.`;
    },
  },
  block_title_pattern: {
    summary: "hide postings whose title matches a pattern (regular expression)",
    apply(params, layers) {
      const pattern = String(params.pattern || "").trim();
      if (!pattern) throw new ConfigError("pattern is required");
      try {
        // Compile exactly the way filters/blocklist.mjs will — a pattern that
        // only fails at 07:00 would be a silent no-op filter forever.
        new RegExp(pattern, "i");
      } catch (e) {
        throw new ConfigError(`not a valid regular expression: ${e.message}`);
      }
      ensureFilter(layers.production, "blocklist");
      const bl = ((layers.production.filterConfig ||= {}).blocklist ||= { companies: [], titlePatterns: [] });
      bl.titlePatterns ||= [];
      if (!bl.titlePatterns.includes(pattern)) bl.titlePatterns.push(pattern);
      return `postings with titles matching /${pattern}/i are hidden.`;
    },
  },
  set_recency_days: {
    summary: "only show postings from the last N days",
    apply(params, layers) {
      const days = Number(params.days);
      if (!Number.isFinite(days) || days <= 0 || days > 365) throw new ConfigError("days must be a number between 1 and 365");
      ensureFilter(layers.production, "recency");
      ((layers.production.filterConfig ||= {}).recency ||= {}).maxAgeDays = days;
      return `digests now only include postings from the last ${days} days.`;
    },
  },
  set_recency_off: {
    summary: "show postings of any age again",
    apply(params, layers) {
      layers.production.filters = (layers.production.filters || ["keyword-match"]).filter(f => f !== "recency");
      return "recency filtering is off — postings of any age can appear.";
    },
  },
  set_daily_limit: {
    summary: "how many postings get fully scored per run",
    apply(params, layers) {
      const limit = Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DAILY_LIMIT) {
        throw new ConfigError(`limit must be a whole number between 1 and ${MAX_DAILY_LIMIT} (colibri scores 1 posting at a time — higher means much longer runs)`);
      }
      ((layers.production.selection ||= {}).limit) = limit;
      return `each run will score up to ${limit} posting(s).`;
    },
  },
  set_reserved_slots: {
    summary: "hold N slots for generic job boards so big companies can't crowd them out",
    apply(params, layers) {
      const slots = Number(params.slots);
      if (!Number.isInteger(slots) || slots < 0 || slots > 9) throw new ConfigError("slots must be a whole number between 0 and 9");
      ((layers.production.selection ||= {}).reservedSlots) = slots;
      return slots === 0
        ? "reserved slots are off — candidates are picked purely by priority."
        : `${slots} slot(s) per run are reserved for generic board postings.`;
    },
  },
  set_per_company_max: {
    summary: "at most N postings from the same company per run",
    apply(params, layers) {
      const n = Number(params.max);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new ConfigError("max must be a whole number between 1 and 10");
      ((layers.production.selection ||= {}).perCompanyMax) = n;
      return `at most ${n} posting(s) per company per run.`;
    },
  },
  toggle_source: {
    summary: "enable/disable a job board",
    apply(params, layers, live) {
      const source = String(params.source || "");
      if (!live.sources[source]) throw new ConfigError(`unknown source "${source}" — known: ${Object.keys(live.sources).join(", ")}`);
      if (typeof params.enabled !== "boolean") throw new ConfigError("enabled must be true or false");
      ((layers.base.sources ||= {})[source] ||= {}).enabled = params.enabled;
      return `${source} is now ${params.enabled ? "enabled" : "disabled"}.`;
    },
  },
  add_watched_company: {
    summary: "add a company's job board to the watched list (verify the slug first!)",
    apply(params, layers, live) {
      const ats = String(params.ats || "");
      const slug = String(params.slug || "").trim();
      const label = String(params.label || "").trim();
      if (!ATS_FAMILIES.includes(ats)) throw new ConfigError(`ats must be one of: ${ATS_FAMILIES.join(", ")}`);
      if (!/^[a-z0-9-]+$/i.test(slug)) throw new ConfigError("slug must be the board's URL path segment (letters, digits, dashes)");
      if (!label) throw new ConfigError("label (the company's display name) is required");
      for (const [family, boards] of Object.entries(live.ats || {})) {
        if (boards[slug]) throw new ConfigError(`slug "${slug}" is already watched under ${family} (${boards[slug].label})`);
      }
      ((layers.base.ats ||= {})[ats] ||= {})[slug] = { label };
      return `${label} added under ${ats}. NOTE: lever is disabled repo-wide (its public API is gone) — prefer greenhouse/workable/ashby.`;
    },
  },
  remove_watched_company: {
    summary: "stop watching a company's job board",
    apply(params, layers, live) {
      const ats = String(params.ats || "");
      const slug = String(params.slug || "").trim();
      if (!ATS_FAMILIES.includes(ats)) throw new ConfigError(`ats must be one of: ${ATS_FAMILIES.join(", ")}`);
      if (!live.ats?.[ats]?.[slug]) throw new ConfigError(`"${slug}" is not watched under ${ats}`);
      delete layers.base.ats[ats][slug];
      if (!Object.keys(layers.base.ats[ats]).length) delete layers.base.ats[ats];
      return `${live.ats[ats][slug].label} removed from the watched list.`;
    },
  },
  list_backups: {
    summary: "list config snapshots (restore points)",
    apply(_params, _layers, _live, ctx) {
      return { backups: ctx.listBackups() };
    },
  },
  restore_backup: {
    summary: "restore configs from a snapshot",
    apply(params, layers, _live, ctx) {
      const file = String(params.file || "");
      if (!/^[A-Za-z0-9._-]+$/.test(file)) throw new ConfigError("bad backup file name");
      const full = path.join(ctx.backupDir, file);
      if (!fs.existsSync(full)) throw new ConfigError(`no such backup: ${file}`);
      const snap = readJsonFile(full); // { base, production }
      if (!snap?.base || !snap?.production) throw new ConfigError("backup snapshot is malformed");
      // Load into the working layers — the common write path below validates
      // the merged result, snapshots the pre-restore state, and writes
      // atomically, exactly like any other action.
      layers.base = snap.base;
      layers.production = snap.production;
      return `configs restored from ${file}.`;
    },
  },
};

// --- status-page chat -------------------------------------------------------
// Chat may drive everything except the backup/restore pair — the one path
// where a model misfire could lose config state. /action (agents, curl)
// keeps the full table.
const CHAT_ACTIONS = Object.keys(ACTIONS).filter(a => a !== "list_backups" && a !== "restore_backup");
const CHAT_FORMAT = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...CHAT_ACTIONS, "none"] },
    params: { type: "object" },
    reply: { type: "string" },
  },
  required: ["action", "params", "reply"],
};

const CHAT_PARAM_CHEATSHEET = [
  "set_track_keywords {track, keywords: [strings]} — replace a track's keywords",
  "set_track_weight {track, weight: number}",
  "set_track_label {track, label: string}",
  "block_company {company: string}",
  "unblock_company {company: string}",
  "block_title_pattern {pattern: regex string}",
  "unblock_title_pattern {pattern: regex string}",
  "set_recency_days {days: number}",
  "set_recency_off {}",
  "set_daily_limit {limit: number}",
  "set_reserved_slots {slots: number}",
  "set_per_company_max {max: number}",
  "toggle_source {source: board name, enabled: boolean}",
  "add_watched_company {ats, slug, label}",
  "remove_watched_company {ats, slug}",
].join("\n");

function chatSystemPrompt(live) {
  const c = curatedView(live);
  return [
    "You are the jobscrape assistant. The user chats in plain English; you respond by choosing exactly one config action.",
    "Current config:",
    "tracks: " + JSON.stringify(Object.fromEntries(Object.entries(c.tracks).map(([k, t]) => [k, { label: t.label, keywords: t.keywords }]))),
    "watched companies: " + JSON.stringify(c.watchedCompanies),
    "blocked companies: " + JSON.stringify(c.blocklist.companies),
    "boards: " + JSON.stringify(c.sources),
    "Actions:",
    CHAT_PARAM_CHEATSHEET,
    "Rules:",
    "Reply with JSON only: action, params, reply.",
    'If the user asks a question or chats without requesting a change, use action "none" and answer in reply.',
    "Change at most one thing per message. Use exactly the track ids, board names and company slugs listed above.",
    "add_watched_company: ats must be greenhouse, workable or ashby (lever is disabled); slug is the URL path segment of the company's job board; label is the display name.",
    "block_title_pattern / unblock_title_pattern: pattern is a regular expression.",
  ].join("\n");
}

async function chatTurn(configDir, message) {
  const live = mergedConfig(configDir);
  const payload = {
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: chatSystemPrompt(live) },
      { role: "user", content: String(message || "").slice(0, 2000) },
    ],
    stream: false,
    format: CHAT_FORMAT, // structured output — gemma can only answer inside the schema
    // num_ctx: the variant's Modelfile sets num_ctx 65536; without an
    // override the chat forces the full 64k KV-cache allocation — instant
    // OOM 500 on a 7 GB CI runner (smoke #9 arm64), while the scrape itself
    // only ever loads a small per-request window. Chat prompts are ~1 KB.
    options: { temperature: 0, num_ctx: 8192 },
  };
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ConfigError(`cannot reach Ollama at ${OLLAMA_URL} — is it running? (${e.cause?.code || e.message})`);
  }
  if (!res.ok) throw new ConfigError(`Ollama answered ${res.status} for model ${CHAT_MODEL} — is the model pulled?`);
  const out = await res.json();
  let parsed;
  try { parsed = JSON.parse(out.message?.content || "{}"); } catch { throw new ConfigError("the model's answer was not valid JSON"); }
  const reply = String(parsed.reply || "").trim();
  const action = String(parsed.action || "").trim();
  if (!action || action === "none" || !CHAT_ACTIONS.includes(action)) {
    return {
      applied: false,
      action: null,
      reply: reply || "I can change tracks, keywords, watched companies, blocklists and boards — e.g. 'block Acme Corp' or 'add Stripe under greenhouse'.",
    };
  }
  // The model only CHOOSES; performAction validates every param, snapshots a
  // restore point and writes atomically, exactly as for agent/curl callers.
  const result = performAction(configDir, { action, params: parsed.params || {} });
  return { applied: true, action, reply: result.note || reply, config: result.config };
}

// --- write path -------------------------------------------------------------

function performAction(configDir, body) {
  const action = ACTIONS[body?.action];
  if (!action) {
    throw new ConfigError(`unknown action "${body?.action}" — available: ${Object.keys(ACTIONS).join(", ")}`);
  }
  const params = body.params || {};
  const layers = readLayers(configDir); // raw working copies — mutated by apply
  const live = mergedConfig(configDir);
  const before = { base: JSON.stringify(layers.base), production: JSON.stringify(layers.production) };

  const backupDir = path.join(configDir, "configs", ".backups");
  const ctx = {
    configDir,
    backupDir,
    listBackups() {
      try {
        return fs.readdirSync(backupDir).filter(f => f.endsWith(".json")).sort().reverse();
      } catch {
        return [];
      }
    },
  };

  // Mutations happen on in-memory copies first; only a fully valid result is
  // allowed anywhere near disk.
  const result = action.apply(params, layers, live, ctx);
  // A string result is the plain-language note; an object result (e.g.
  // list_backups' { backups }) rides along as structured data.
  const note = typeof result === "string" ? result : result?.note;
  const extra = result && typeof result === "object" ? result : {};

  const files = [];
  if (JSON.stringify(layers.base) !== before.base) files.push(layers.baseFile);
  if (JSON.stringify(layers.production) !== before.production) files.push(layers.prodFile);

  if (files.length) {
    validateLayers(configDir, layers); // throws -> nothing below runs, disk untouched
    fs.mkdirSync(backupDir, { recursive: true });
    const snap = `${nowStamp()}-${body.action}.json`;
    // Snapshot the PRE-WRITE state (the `before` serializations were captured
    // before apply() mutated anything) — this file IS the undo point. A
    // snapshot of the mutated layers would make restore a no-op.
    fs.writeFileSync(
      path.join(backupDir, snap),
      `{\n"base": ${before.base},\n"production": ${before.production}\n}\n`,
    );
    for (const f of files) writeJsonFile(f, f === layers.baseFile ? layers.base : layers.production);
    fs.appendFileSync(
      path.join(backupDir, "audit.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), action: body.action, params, files: files.map(f => path.basename(f)), backup: snap }) + "\n",
    );
  }

  return {
    ok: true,
    action: body.action,
    note: note || (files.length ? "config updated — takes effect on the next run." : "nothing changed."),
    ...extra,
    config: curatedView(mergedConfig(configDir)),
  };
}

// --- reads ------------------------------------------------------------------

function curatedView(live) {
  return {
    tracks: Object.fromEntries(Object.entries(live.tracks).map(([k, t]) => [
      k, { label: t.label, description: t.description, keywords: t.keywords, weight: t.weight },
    ])),
    blocklist: {
      companies: live.filterConfig?.blocklist?.companies || [],
      titlePatterns: live.filterConfig?.blocklist?.titlePatterns || [],
      enabled: (live.filters || []).includes("blocklist"),
    },
    recency: {
      maxAgeDays: (live.filters || []).includes("recency") ? live.filterConfig?.recency?.maxAgeDays ?? 30 : null,
    },
    selection: {
      limit: live.selection.limit,
      reservedSlots: live.selection.reservedSlots,
      perCompanyMax: live.selection.perCompanyMax,
    },
    sources: Object.fromEntries(Object.entries(live.sources).map(([k, s]) => [k, { enabled: s.enabled !== false }])),
    watchedCompanies: Object.fromEntries(Object.entries(live.ats || {}).map(([family, boards]) => [
      family, Object.fromEntries(Object.entries(boards).map(([slug, b]) => [slug, b.label])),
    ])),
  };
}

function statusView(configDir, stateDir, logsDir) {
  const live = mergedConfig(configDir);
  const stamp = new Date().toISOString().slice(0, 10);
  const todayRankings = loadTodayRankings(stamp, stateDir);
  return {
    date: stamp,
    digest: renderSummaryJson(todayRankings, 5, live.tracks),
    pendingColibri: loadPendingQueue(stateDir).size,
    seenPostings: loadSeen(stateDir).size,
    sourcesEnabled: Object.entries(live.sources).filter(([, s]) => s.enabled !== false).map(([k]) => k),
  };
}

function tailLog(logsDir, lines = 10) {
  try {
    const logs = fs.readdirSync(logsDir).filter(f => f.endsWith(".log")).sort();
    if (!logs.length) return [];
    return fs.readFileSync(path.join(logsDir, logs[logs.length - 1]), "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

function statusHtml(configDir, stateDir, logsDir) {
  const s = statusView(configDir, stateDir, logsDir);
  const rows = s.digest.map(r =>
    `<tr><td>${esc(r.track_label)}</td><td>${esc(r.company)}</td><td><a href="${esc(r.url)}">${esc(r.title)}</a></td><td>${esc(r.score)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>jobscrape status</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}code{background:#f4f4f4;padding:.1rem .3rem}
#chatlog div{margin:.3rem 0;padding:.4rem .6rem;border-radius:.4rem;max-width:80%}
#chatlog .me{background:#e8f0fe;margin-left:auto}#chatlog .bot{background:#f4f4f4}
#chatin{padding:.4rem;width:26rem}</style></head><body>
<h1>jobscrape status</h1>
<p>${esc(s.date)} — ${esc(String(s.digest.length))} ranked today · ${esc(String(s.pendingColibri))} waiting for colibri · ${esc(String(s.seenPostings))} seen all-time</p>
<p>Boards watched: ${esc(s.sourcesEnabled.join(", "))}</p>
<h2>Today's digest (top 5 per track)</h2>
<table><tr><th>Track</th><th>Company</th><th>Title</th><th>Score</th></tr>${rows || "<tr><td colspan=4>nothing ranked yet today</td></tr>"}</table>
<h2>Chat config</h2>
<div id="chatlog"></div>
<p><input id="chatin" placeholder="e.g. block Acme Corp — or ask: what tracks do I have?"> <button id="chatsend">Send</button></p>
<script>
(function () {
  var log = document.getElementById("chatlog");
  var input = document.getElementById("chatin");
  var btn = document.getElementById("chatsend");
  var token = new URLSearchParams(location.search).get("token") || "";
  function bubble(text, cls) {
    var d = document.createElement("div");
    d.className = cls;
    d.textContent = text; // textContent, never innerHTML — replies come from a model
    log.appendChild(d);
    return d;
  }
  function send() {
    var msg = input.value.trim();
    if (!msg || btn.disabled) return;
    input.value = "";
    btn.disabled = true;
    bubble(msg, "me");
    var wait = bubble("thinking...", "bot");
    fetch("/chat?token=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg })
    }).then(function (r) { return r.json(); }).then(function (out) {
      wait.textContent = out.reply || out.error || "nothing happened";
      if (out.applied) setTimeout(function () { location.reload(); }, 1500);
    }).catch(function () {
      wait.textContent = "could not reach the assistant — is Ollama running?";
    }).finally(function () {
      btn.disabled = false;
      input.focus();
    });
  }
  btn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
})();
</script>
</body></html>`;
}

// --- server -----------------------------------------------------------------

export function createConfigServer({ configDir = __dirname, stateDir, logsDir, token = TOKEN } = {}) {
  if (!token) throw new ConfigError("JOBSCRAPE_CONFIG_TOKEN is not set — refusing to start (fail-closed)");

  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    const log = code => console.error(`[config-server] ${new Date().toISOString()} ${route} -> ${code}`);

    if (req.method === "GET" && url.pathname === "/health") {
      log(200);
      return json(res, 200, { ok: true });
    }

    if (!authorized(req, url, token)) {
      log(401);
      return json(res, 401, { error: "unauthorized — set Authorization: Bearer <JOBSCRAPE_CONFIG_TOKEN> (token lives in the repo .env)" });
    }

    try {
      if (req.method === "GET" && url.pathname === "/config") {
        log(200);
        return json(res, 200, curatedView(mergedConfig(configDir)));
      }
      if (req.method === "GET" && url.pathname === "/status") {
        log(200);
        return json(res, 200, { ...statusView(configDir, stateDir, logsDir), lastLogLines: tailLog(logsDir) });
      }
      if (req.method === "GET" && url.pathname === "/") {
        // Render BEFORE writing headers — statusHtml can throw (fresh
        // install, unreadable state) and the catch below must still be able
        // to send a clean JSON 500.
        const html = statusHtml(configDir, stateDir, logsDir);
        log(200);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      if (req.method === "POST" && url.pathname === "/action") {
        let body = "";
        req.on("data", chunk => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) req.destroy(); // oversized — drop the connection
        });
        return req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const out = performAction(configDir, parsed);
            log(200);
            json(res, 200, out);
          } catch (e) {
            const code = e instanceof ConfigError ? 400 : 500;
            log(code);
            json(res, code, { error: e.message });
          }
        });
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        let body = "";
        req.on("data", chunk => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) req.destroy(); // oversized — drop the connection
        });
        return req.on("end", async () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const out = await chatTurn(configDir, parsed.message);
            log(200);
            json(res, 200, out);
          } catch (e) {
            const code = e instanceof ConfigError ? 400 : 500;
            log(code);
            json(res, code, { error: e.message });
          }
        });
      }
      log(404);
      return json(res, 404, { error: "not found" });
    } catch (e) {
      log(500);
      return json(res, 500, { error: e.message });
    }
  });
}

// --- entry point (only when run directly; tests import the factory) --------

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const server = createConfigServer({
    configDir: __dirname,
    stateDir: undefined, // state.mjs default (JOBSCRAPE_STATE_DIR or ./state)
    logsDir: path.join(__dirname, "logs"),
  });
  server.on("error", e => {
    console.error(`[config-server] FATAL: ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.error(`[config-server] listening on 0.0.0.0:${PORT} — token-gated (GET /health open)`);
  });
}
