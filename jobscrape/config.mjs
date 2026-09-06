// config.mjs — config loading for the jobscrape pipeline.
//
// Single entry point: loadConfig(). Every module that used to
// `JSON.parse(readFileSync("config.json"))` goes through this instead, so the
// pipeline gains three things without changing what a bare `node scrape.mjs
// --once` does:
//
//   1. DEFAULTS — every tuning value the pipeline used to hardcode inline
//      (score caps, excerpt lengths, prompt parameters, prune windows, ...)
//      lives here as the canonical fallback. configs/base.json only needs to
//      carry the values worth seeing in a diff.
//   2. deepMerge — profiles (commit 3: configs/<name>.json) layer over the
//      base config. Plain objects merge recursively; ARRAYS REPLACE wholesale
//      (a profile's `scorers: ["keyword-heuristic"]` must not inherit the
//      colibri chain); `null` is a meaningful "off" and survives the merge.
//   3. validateConfig — unknown keys are an error (with a Levenshtein
//      suggestion for near-miss typos), type mismatches are an error. Failing
//      loudly at load beats a silent default silently outranking an explicit
//      setting.
//
// No dependencies: everything here is stdlib. Tests live in test/config.test.mjs
// (`npm test`).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ConfigError extends Error {}

// ---------------------------------------------------------------------------
// DEFAULTS — today's inline hardcoded values, per file:
//   scrape.mjs   limit 40, perCompanyMax 3, SOURCE_PRIORITY table, unknown
//                source priority 3, drafts default 3, prune 7 days, top-N 5,
//                card excerpt 2000, table cell 60
//   colibri.mjs  max_tokens chunk*256, temperature 0.2, excerpt 800,
//                one_line cap 200, fit_notes cap 500, busy-check 3 x 5000ms
//                with a 2000ms health timeout
//   keywords.mjs 15 points/keyword, cap 100, default weight 1
//   sources.mjs  Chrome UA, HN hitsPerPage 200 / 3000-char bodies / 120-char
//                first line / 60-char company
//   draft.mjs    max_tokens 512, temperature 0.4, excerpt 2000
//   tailor.mjs   max_tokens 4096, temperature 0.3, excerpt 8000
//
// fetch.timeoutMs defaults to null (= no fetch timeout, today's behavior).
// A real timeout lands as a deliberate default change later, not silently.
// ---------------------------------------------------------------------------
export const DEFAULTS = {
  // Volume-writer targets (see volume-writer.mjs). render-resume.mjs writes to
  // the workspace ROOT, deliberately not under workspacePath.
  workspaceVolume: "openclaw-sandbox_openclaw-workspace",
  workspacePath: "/home/node/.openclaw/workspace/jobs",

  // Run-mode knobs that CLI flags also control; the flag always wins.
  run: {
    dryRun: false,
    draftDefaultCount: 3, // `--drafts` with no number
  },

  // Which candidates make it into a run at all (see pipeline/selection.mjs).
  selection: {
    limit: 40, // --limit default; production overrides to 10
    perCompanyMax: 3, // round-robin cap per company per priority tier
    // Curated ATS boards rank ahead of generic boards; unknown sources land
    // at unknownSourcePriority (0 = curated ... 3 = last).
    sourcePriorities: { greenhouse: 0, lever: 0, workable: 0, ashby: 0, remotive: 1, hn: 1, remoteok: 2, wwr: 2 },
    unknownSourcePriority: 3,
  },

  // Pipeline stage chains (names resolved against pipeline/registry.mjs).
  // filters run pre-dedupe; scorers run in order, last one terminal.
  filters: ["keyword-match"],
  scorers: ["keyword-gate", "colibri", "keyword-heuristic"],
  // Per-filter options, keyed by filter name. Open map — each filter's init()
  // validates its own slice.
  filterConfig: {},

  // Where a fetched posting's bytes come from. timeoutMs: null disables the
  // timeout entirely.
  fetch: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    timeoutMs: null,
    hn: {
      hitsPerPage: 200,
      maxBodyChars: 3000,
      firstLineMaxChars: 120,
      companyMaxChars: 60,
    },
  },

  // Digest/card presentation.
  output: {
    digestStatePruneDays: 7,
    topNPerTrack: 5,
    cardExcerptChars: 2000,
    tableCellChars: 60,
  },

  // Colibri HTTP client + generation parameters. generation.* must stay
  // byte-stable once prompts are cached (see pipeline/prompt.mjs) — changing
  // these costs one full re-prefill of the local model.
  colibri: {
    baseUrl: "http://localhost:8000/v1",
    model: "glm-5.2-colibri",
    timeoutMs: 900000,
    chunkSize: 1,
    // >= this heuristic score skips the colibri call entirely; null disables
    // the pre-gate.
    heuristicSkipThreshold: 70,
    // mcp-colibri's loopback /health — politeness check before firing so a
    // host-side batch doesn't queue behind an in-sandbox ask_colibri call.
    mcpHealthUrl: "http://127.0.0.1:8090/health",
    generation: {
      maxTokensPerPosting: 256,
      temperature: 0.2,
      bodyExcerptChars: 800,
      oneLineMaxChars: 200,
      fitNotesMaxChars: 500,
    },
    busyCheck: {
      maxAttempts: 3,
      pollDelayMs: 5000,
      requestTimeoutMs: 2000,
    },
  },

  // Keyword heuristic scoring (keywords.mjs): score = distinct keyword hits
  // * pointsPerKeyword * track weight, capped at scoreCap.
  scoring: {
    keyword: {
      pointsPerKeyword: 15,
      scoreCap: 100,
      defaultWeight: 1,
    },
  },

  // Cover-letter drafting (draft.mjs, --drafts).
  draft: {
    maxTokens: 512,
    temperature: 0.4,
    bodyExcerptChars: 2000,
  },

  // Resume tailoring (tailor.mjs) — a full two-page resume needs far more
  // generation budget than a cover letter.
  tailor: {
    maxTokens: 4096,
    temperature: 0.3,
    bodyExcerptChars: 8000,
  },

  // tracks / sources / ats / wwr are deliberately NOT defaulted: they are
  // user content (which companies, which keywords), not tuning. A config
  // without them is invalid and validateConfig says so.
};

// ---------------------------------------------------------------------------
// deepMerge — base values layered with overrides.
//   plain object + plain object  -> recurse
//   array + anything             -> REPLACE (never element-merge: a profile's
//                                   `scorers: ["keyword-heuristic"]` must not
//                                   silently keep colibri in the chain)
//   null / scalar                -> replace (null = meaningful "off")
// ---------------------------------------------------------------------------
export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (override === null || typeof override !== "object") return override;
  if (base === null || typeof base !== "object") return override;

  const out = { ...base };
  for (const [key, val] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], val) : val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legacy aliases — keys the config once grew that no longer mean what they
// say, rewritten to their current homes (with a warning) instead of tripping
// the unknown-key error forever.
// ---------------------------------------------------------------------------
export function applyLegacyAliases(raw) {
  const out = { ...raw };

  // `dailyCap` was never read by any code path (the real cap is --limit /
  // selection.limit) — keeping it around invited "I set dailyCap, why nothing
  // changed" confusion. Drop it loudly.
  if ("dailyCap" in out) {
    console.error("[config] ignoring legacy key `dailyCap` (read by nothing) — the run cap is `selection.limit` / --limit");
    delete out.dailyCap;
  }

  // `perCompanyMax` moved under `selection.` — alias it so existing configs
  // keep working, but an explicit `selection.perCompanyMax` wins over the
  // legacy spelling.
  if ("perCompanyMax" in out) {
    if (out.selection?.perCompanyMax === undefined) {
      console.error("[config] `perCompanyMax` is now `selection.perCompanyMax` — please move it");
      out.selection = { ...(out.selection || {}), perCompanyMax: out.perCompanyMax };
    } else {
      console.error("[config] ignoring legacy `perCompanyMax` — `selection.perCompanyMax` takes precedence");
    }
    delete out.perCompanyMax;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Types that can't be inferred from the DEFAULTS value (nullable keys, and
// numeric keys where 0/negative is legitimate so the "positive int" inference
// would be wrong).
const TYPES = {
  "fetch.timeoutMs": "intOrNull",
  "colibri.mcpHealthUrl": "stringOrNull",
  "colibri.heuristicSkipThreshold": "intOrNull",
  "selection.unknownSourcePriority": "nonNegInt",
  // Open-ended source → priority map; 0 is a legitimate (curated) priority,
  // and source names are user content, so this can't be inferred as a
  // positive-int object.
  "selection.sourcePriorities": "numberMap",
  "colibri.generation.temperature": "number",
  "draft.temperature": "number",
  "tailor.temperature": "number",
};

function typeOfValue(v) {
  if (Array.isArray(v)) return "stringArray";
  if (v === null) return "null";
  switch (typeof v) {
    case "string": return "string";
    case "boolean": return "boolean";
    case "number": return Number.isInteger(v) ? "posInt" : "number";
    default: return "object";
  }
}

function checkType(path, value, expected, problems) {
  switch (expected) {
    case "string":
      if (typeof value !== "string") problems.push(`${path} must be a string`);
      break;
    case "stringOrNull":
      if (typeof value !== "string" && value !== null) problems.push(`${path} must be a string or null`);
      break;
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${path} must be true or false`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${path} must be a number`);
      break;
    case "posInt":
      if (!Number.isInteger(value) || value < 1) problems.push(`${path} must be a positive integer`);
      break;
    case "nonNegInt":
      if (!Number.isInteger(value) || value < 0) problems.push(`${path} must be an integer >= 0`);
      break;
    case "intOrNull":
      if (value !== null && (!Number.isInteger(value) || value < 1)) problems.push(`${path} must be a positive integer or null`);
      break;
    case "stringArray":
      if (!Array.isArray(value) || !value.every(x => typeof x === "string")) problems.push(`${path} must be an array of strings`);
      break;
    case "numberMap":
      if (typeof value !== "object" || value === null || Array.isArray(value)
          || !Object.values(value).every(v => typeof v === "number" && Number.isFinite(v))) {
        problems.push(`${path} must be an object mapping names to numbers`);
      }
      break;
    default:
      problems.push(`${path}: internal error, unknown expected type "${expected}"`);
  }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[m][n];
}

function suggestKey(typo, candidates) {
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const dist = levenshtein(typo.toLowerCase(), c.toLowerCase());
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  // Only suggest when it's plausibly the same word — a suggestion for a
  // genuinely different key is noise.
  return bestDist <= Math.min(3, best.length / 2) ? best : null;
}

// Structurally-validated open maps — new keys inside them are user content
// (a new track, a new company), not typos, so the type walk skips them and
// validateOpenMaps checks their entries' shape instead.
const OPEN_KEYS = new Set(["tracks", "sources", "ats", "wwr", "filterConfig"]);

function validateOpenMaps(cfg, problems) {
  if (cfg.tracks !== undefined) {
    if (typeof cfg.tracks !== "object" || cfg.tracks === null || Array.isArray(cfg.tracks) || !Object.keys(cfg.tracks).length) {
      problems.push("tracks must be a non-empty object of { label, keywords, weight?, description? }");
    } else {
      for (const [key, track] of Object.entries(cfg.tracks)) {
        if (typeof track !== "object" || track === null) { problems.push(`tracks.${key} must be an object`); continue; }
        if (typeof track.label !== "string" || !track.label) problems.push(`tracks.${key}.label must be a non-empty string`);
        if (!Array.isArray(track.keywords) || !track.keywords.length || !track.keywords.every(kw => typeof kw === "string" && kw)) {
          problems.push(`tracks.${key}.keywords must be a non-empty array of non-empty strings`);
        }
        if (track.weight !== undefined && (typeof track.weight !== "number" || !Number.isFinite(track.weight) || track.weight < 0)) {
          problems.push(`tracks.${key}.weight must be a number >= 0`);
        }
        // Required: feeds the generated colibri prompt's numbered track lines
        // (pipeline/prompt.mjs) — a track without one can't be scored.
        if (typeof track.description !== "string" || !track.description) {
          problems.push(`tracks.${key}.description must be a non-empty string (feeds the generated colibri prompt)`);
        }
      }
    }
  }

  if (cfg.sources !== undefined) {
    if (typeof cfg.sources !== "object" || cfg.sources === null || Array.isArray(cfg.sources) || !Object.keys(cfg.sources).length) {
      problems.push("sources must be a non-empty object of { enabled: boolean }");
    } else {
      for (const [key, src] of Object.entries(cfg.sources)) {
        if (typeof src !== "object" || src === null || typeof src.enabled !== "boolean") {
          problems.push(`sources.${key}.enabled must be true or false`);
        }
      }
    }
  }

  if (cfg.ats !== undefined) {
    if (typeof cfg.ats !== "object" || cfg.ats === null || Array.isArray(cfg.ats)) {
      problems.push("ats must be an object keyed by source: { <source>: { <slug>: { label } } }");
    } else {
      for (const [source, slugs] of Object.entries(cfg.ats)) {
        if (typeof slugs !== "object" || slugs === null) { problems.push(`ats.${source} must be an object of { slug: { label } }`); continue; }
        for (const [slug, meta] of Object.entries(slugs)) {
          if (typeof meta !== "object" || meta === null || typeof meta.label !== "string" || !meta.label) {
            problems.push(`ats.${source}.${slug}.label must be a non-empty string`);
          }
        }
      }
    }
  }

  if (cfg.wwr !== undefined) {
    if (typeof cfg.wwr !== "object" || cfg.wwr === null || !Array.isArray(cfg.wwr.categories) || !cfg.wwr.categories.every(c => typeof c === "string")) {
      problems.push("wwr.categories must be an array of strings");
    }
  }

  // filterConfig is fully open — each filter's init() owns validating its
  // own slice (and throws ConfigError from there, not from here).
}

/**
 * Validate a merged config object against DEFAULTS. Throws ConfigError with
 * every problem found (not just the first) so a typo'd config is fixed in
 * one edit.
 */
export function validateConfig(cfg) {
  const problems = [];

  if (!cfg.tracks) problems.push("tracks is required (at least one track)");
  if (!cfg.sources) problems.push("sources is required (at least one source)");

  const walk = (obj, defaults, path) => {
    for (const [key, defVal] of Object.entries(defaults)) {
      const here = path ? `${path}.${key}` : key;
      if (!(key in obj)) continue; // absent = default applies
      if (OPEN_KEYS.has(here)) continue; // open map — validated structurally
      const val = obj[key];
      const expected = TYPES[here] ?? typeOfValue(defVal);
      if (expected === "object") {
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          problems.push(`${here} must be an object`);
        } else {
          walk(val, defVal, here);
          // Unknown sub-keys under a known object are still typos.
          for (const sub of Object.keys(val)) {
            if (!(sub in defVal)) {
              const hint = suggestKey(sub, Object.keys(defVal));
              problems.push(`unknown key \`${here}.${sub}\`${hint ? ` — did you mean \`${here}.${hint}\`?` : ""}`);
            }
          }
        }
      } else {
        checkType(here, val, expected, problems);
      }
    }
    for (const key of Object.keys(obj)) {
      if (key in defaults) continue;
      // Open maps are user content at any level they legitimately appear
      // (all of them are top-level) — never a typo.
      if (!path && OPEN_KEYS.has(key)) continue;
      const hint = suggestKey(key, Object.keys(defaults));
      problems.push(`unknown key \`${path ? `${path}.${key}` : key}\`${hint ? ` — did you mean \`${hint}\`?` : ""}`);
    }
  };

  walk(cfg, DEFAULTS, "");
  validateOpenMaps(cfg, problems);

  if (problems.length) {
    throw new ConfigError(`invalid jobscrape config:\n  - ${problems.join("\n  - ")}`);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// loadConfig — configs/base.json layered with a named profile, over DEFAULTS,
// validated. Synchronous on purpose: every caller is a CLI entry point that
// needs the config before anything async starts.
//
// Layering: DEFAULTS <- configs/base.json <- configs/<profile>.json
// Profile precedence: --profile flag > JOBSCRAPE_PROFILE env > "production".
// Pass profile "base" explicitly for base.json alone (pure defaults + base).
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  if (!existsSync(file)) {
    throw new ConfigError(`config file not found: ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`failed to parse ${file}: ${e.message}`);
  }
}

function availableProfiles(dir) {
  try {
    return readdirSync(resolve(dir, "configs"))
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * @param {{ dir?: string, profile?: string }} [opts] — dir holding configs/
 *   (default: JOBSCRAPE_CONFIG_DIR env, else this module's directory);
 *   profile name override. The env + opts exist for tests/deployments that
 *   keep configs outside the source tree.
 */
export function loadConfig(opts = {}) {
  const dir = opts.dir || process.env.JOBSCRAPE_CONFIG_DIR || __dirname;
  const profile = opts.profile ?? process.env.JOBSCRAPE_PROFILE ?? "production";

  if (profile && /[\\/]|\.\./.test(profile)) {
    // Profile names are file names under configs/ — refuse anything that
    // could climb out of that directory.
    throw new ConfigError(`invalid profile name: "${profile}"`);
  }

  // Aliases apply to each file BEFORE merging, so a legacy spelling works
  // the same whether it sits in base.json or in a profile.
  let cfg = deepMerge(DEFAULTS, applyLegacyAliases(readJsonFile(resolve(dir, "configs", "base.json"))));
  if (profile && profile !== "base") {
    const file = resolve(dir, "configs", `${profile}.json`);
    if (!existsSync(file)) {
      throw new ConfigError(`profile not found: configs/${profile}.json (available: ${availableProfiles(dir).join(", ") || "none"})`);
    }
    cfg = deepMerge(cfg, applyLegacyAliases(readJsonFile(file)));
  }

  return validateConfig(cfg);
}
