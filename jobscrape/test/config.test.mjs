// config.test.mjs — config.mjs unit tests: deepMerge layering rules, legacy
// aliases, validation errors, and loading the real repo config.
// Run: npm test   (node --test test/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULTS, deepMerge, applyLegacyAliases, validateConfig, loadConfig, ConfigError,
} from "../config.mjs";

// Minimal user content — tracks/sources/ats are required and have no defaults.
const MINIMAL = {
  tracks: { esports: { label: "Esports", keywords: ["esport"] } },
  sources: { hn: { enabled: true } },
};

test("deepMerge recurses into plain objects, siblings survive", () => {
  const merged = deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } });
  assert.deepEqual(merged, { a: { x: 1, y: 3 } });
});

test("deepMerge REPLACES arrays wholesale (profile scorers must not inherit)", () => {
  const merged = deepMerge(
    { scorers: ["keyword-gate", "colibri", "keyword-heuristic"] },
    { scorers: ["keyword-heuristic"] },
  );
  assert.deepEqual(merged.scorers, ["keyword-heuristic"]);
});

test("deepMerge preserves null as a meaningful override", () => {
  const merged = deepMerge(
    { colibri: { mcpHealthUrl: "http://x", timeoutMs: 1 } },
    { colibri: { mcpHealthUrl: null } },
  );
  assert.equal(merged.colibri.mcpHealthUrl, null);
  assert.equal(merged.colibri.timeoutMs, 1);
});

test("deepMerge adds keys absent from base", () => {
  assert.equal(deepMerge({ a: 1 }, { b: 2 }).b, 2);
});

test("legacy perCompanyMax moves under selection", () => {
  const out = applyLegacyAliases({ perCompanyMax: 5, sources: { hn: { enabled: true } } });
  assert.equal(out.selection.perCompanyMax, 5);
  assert.equal("perCompanyMax" in out, false);
});

test("explicit selection.perCompanyMax wins over the legacy alias", () => {
  const out = applyLegacyAliases({
    perCompanyMax: 5,
    selection: { perCompanyMax: 2 },
    sources: { hn: { enabled: true } },
  });
  assert.equal(out.selection.perCompanyMax, 2);
});

test("legacy dailyCap is dropped with a warning, not an error", () => {
  const out = applyLegacyAliases({ dailyCap: 40, sources: { hn: { enabled: true } } });
  assert.equal("dailyCap" in out, false);
});

test("valid minimal config validates and fills defaults", () => {
  const cfg = validateConfig(deepMerge(DEFAULTS, MINIMAL));
  assert.equal(cfg.selection.limit, 40);
  assert.equal(cfg.selection.perCompanyMax, 3);
  assert.equal(cfg.scoring.keyword.pointsPerKeyword, 15);
  assert.equal(cfg.colibri.generation.temperature, 0.2);
  assert.deepEqual(cfg.scorers, ["keyword-gate", "colibri", "keyword-heuristic"]);
});

test("near-miss typo gets a Levenshtein suggestion", () => {
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { ...MINIMAL, colibri: { heuristicSkipTreshold: 10 } })),
    /unknown key `colibri\.heuristicSkipTreshold` — did you mean `colibri\.heuristicSkipThreshold`/,
  );
});

test("wrong types are errors", () => {
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { ...MINIMAL, selection: { limit: "lots" } })),
    /selection\.limit must be a positive integer/,
  );
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { ...MINIMAL, scorers: "keyword-heuristic" })),
    /scorers must be an array of strings/,
  );
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { ...MINIMAL, fetch: { timeoutMs: -1 } })),
    /fetch\.timeoutMs/,
  );
});

test("nullable keys accept null (meaningful off-switches)", () => {
  const cfg = validateConfig(deepMerge(DEFAULTS, {
    ...MINIMAL,
    colibri: { heuristicSkipThreshold: null, mcpHealthUrl: null },
    fetch: { timeoutMs: null },
  }));
  assert.equal(cfg.colibri.heuristicSkipThreshold, null);
});

test("all problems reported at once, not just the first", () => {
  try {
    validateConfig(deepMerge(DEFAULTS, {
      ...MINIMAL,
      selection: { limit: 0 },
      output: { topNPerTrack: "five" },
    }));
    assert.fail("expected ConfigError");
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /selection\.limit/);
    assert.match(e.message, /output\.topNPerTrack/);
  }
});

test("track entries need label + keywords; weight/description type-checked", () => {
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { tracks: { x: { label: "X" } }, sources: MINIMAL.sources })),
    /tracks\.x\.keywords/,
  );
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { tracks: { x: { label: "X", keywords: ["k"], weight: "high" } }, sources: MINIMAL.sources })),
    /tracks\.x\.weight/,
  );
});

test("source entries need boolean enabled; ats entries need labels", () => {
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { ...MINIMAL, sources: { hn: { enabled: "yes" } } })),
    /sources\.hn\.enabled/,
  );
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { ...MINIMAL, ats: { greenhouse: { riot: {} } } })),
    /ats\.greenhouse\.riot\.label/,
  );
});

test("open maps accept new user content without erroring", () => {
  const cfg = validateConfig(deepMerge(DEFAULTS, {
    tracks: { brandnew: { label: "Brand New", keywords: ["k"], description: "d" } },
    sources: { newsource: { enabled: true } },
    ats: { greenhouse: { someco: { label: "SomeCo" } } },
    wwr: { categories: ["product"] },
    filterConfig: { recency: { maxAgeDays: 14 } },
  }));
  assert.ok(cfg.tracks.brandnew);
});

test("loadConfig reads the real repo config.json (alias path)", () => {
  // The repo's config.json still uses the pre-selection shape, so this also
  // exercises the perCompanyMax alias end-to-end.
  const cfg = loadConfig();
  assert.equal(cfg.selection.perCompanyMax, 3);
  assert.equal(cfg.colibri.model, "glm-5.2-colibri");
  assert.ok(Object.keys(cfg.tracks).length >= 3);
});

test("loadConfig reads a fixture dir and errors on a bad file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobscrape-config-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      tracks: MINIMAL.tracks, sources: MINIMAL.sources, selection: { limit: 7 },
    }));
    assert.equal(loadConfig({ dir }).selection.limit, 7);

    writeFileSync(join(dir, "config.json"), "{ not json");
    assert.throws(() => loadConfig({ dir }), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws ConfigError on missing config file", () => {
  const dir = join(tmpdir(), `jobscrape-absent-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    assert.throws(() => loadConfig({ dir }), /config file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
