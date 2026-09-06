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
// description is required on tracks: it feeds the generated colibri prompt.
const MINIMAL = {
  tracks: { esports: { label: "Esports", description: "esports ops", keywords: ["esport"] } },
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

test("track entries need label + keywords + description; weight type-checked", () => {
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { tracks: { x: { label: "X" } }, sources: MINIMAL.sources })),
    /tracks\.x\.keywords/,
  );
  assert.throws(
    () => validateConfig(deepMerge(DEFAULTS, { tracks: { x: { label: "X", keywords: ["k"] } }, sources: MINIMAL.sources })),
    /tracks\.x\.description.*feeds the generated colibri prompt/,
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

test("loadConfig reads the real repo configs/ (base + production overlay)", () => {
  const cfg = loadConfig();
  assert.equal(cfg.selection.limit, 10, "production profile caps the run at 10");
  assert.equal(cfg.selection.perCompanyMax, 3, "base.json selection value survives the overlay");
  assert.equal(cfg.colibri.model, "glm-5.2-colibri");
  assert.ok(Object.keys(cfg.tracks).length >= 3);
});

test("--profile flag wins over JOBSCRAPE_PROFILE, which wins over production", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobscrape-profiles-"));
  try {
    const configs = join(dir, "configs");
    mkdirSync(configs, { recursive: true });
    writeFileSync(join(configs, "base.json"), JSON.stringify({
      tracks: MINIMAL.tracks, sources: MINIMAL.sources, selection: { limit: 1 },
    }));
    writeFileSync(join(configs, "production.json"), JSON.stringify({ selection: { limit: 2 } }));
    writeFileSync(join(configs, "dev.json"), JSON.stringify({ selection: { limit: 3 } }));

    assert.equal(loadConfig({ dir }).selection.limit, 2, "default profile is production");
    process.env.JOBSCRAPE_PROFILE = "dev";
    try {
      assert.equal(loadConfig({ dir }).selection.limit, 3, "env var selects the profile");
      assert.equal(loadConfig({ dir, profile: "base" }).selection.limit, 1, "flag beats env var");
    } finally {
      delete process.env.JOBSCRAPE_PROFILE;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile overlays replace arrays wholesale and merge objects", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobscrape-profile-arr-"));
  try {
    const configs = join(dir, "configs");
    mkdirSync(configs, { recursive: true });
    writeFileSync(join(configs, "base.json"), JSON.stringify({
      tracks: MINIMAL.tracks,
      sources: MINIMAL.sources,
      scorers: ["keyword-gate", "colibri", "keyword-heuristic"],
      selection: { limit: 9 },
    }));
    writeFileSync(join(configs, "dev.json"), JSON.stringify({
      scorers: ["keyword-heuristic"],
    }));

    const dev = loadConfig({ dir, profile: "dev" });
    assert.deepEqual(dev.scorers, ["keyword-heuristic"], "array replaced, not element-merged");
    assert.equal(dev.selection.limit, 9, "base selection survives the profile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown profile names error with the available list; traversal is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobscrape-profile-err-"));
  try {
    const configs = join(dir, "configs");
    mkdirSync(configs, { recursive: true });
    writeFileSync(join(configs, "base.json"), JSON.stringify(MINIMAL));
    writeFileSync(join(configs, "production.json"), JSON.stringify({}));

    assert.throws(() => loadConfig({ dir, profile: "nope" }), /profile not found: configs\/nope\.json \(available: base, production\)/);
    assert.throws(() => loadConfig({ dir, profile: "../etc" }), /invalid profile name/);
    assert.throws(() => loadConfig({ dir, profile: "a\\b" }), /invalid profile name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig reads a fixture dir and errors on a bad file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobscrape-config-"));
  try {
    const configs = join(dir, "configs");
    mkdirSync(configs, { recursive: true });
    writeFileSync(join(configs, "base.json"), JSON.stringify({
      tracks: MINIMAL.tracks, sources: MINIMAL.sources, selection: { limit: 7 },
    }));
    assert.equal(loadConfig({ dir, profile: "base" }).selection.limit, 7);

    writeFileSync(join(configs, "base.json"), "{ not json");
    assert.throws(() => loadConfig({ dir, profile: "base" }), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws ConfigError on missing config file", () => {
  const dir = join(tmpdir(), `jobscrape-absent-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    assert.throws(() => loadConfig({ dir, profile: "base" }), /config file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
