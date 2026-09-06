// config-server.test.mjs — the host config/status service.
// Covers the curated action table (right file, right layer, right value),
// the validate-before-disk guarantee, token auth, backups/audit, and the
// read-only /status + / surfaces. Runs against temp config/state dirs via
// the same seams the scrape uses (JOBSCRAPE_CONFIG_DIR equivalents, passed
// explicitly here), on an ephemeral port.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createConfigServer } from "../config-server.mjs";

const TOKEN = "test-token-1234";

const BASE = {
  tracks: {
    alpha: { label: "Alpha Track", keywords: ["alpha"], description: "alpha roles", weight: 2 },
  },
  sources: { remotive: { enabled: true }, remoteok: { enabled: false } },
  ats: { greenhouse: { riotgames: { label: "Riot Games" } } },
};

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfgsrv-"));
  fs.mkdirSync(path.join(dir, "configs"));
  fs.mkdirSync(path.join(dir, "state"));
  fs.mkdirSync(path.join(dir, "logs"));
  fs.writeFileSync(path.join(dir, "configs", "base.json"), JSON.stringify(BASE, null, 2));
  fs.writeFileSync(path.join(dir, "configs", "production.json"), "{}\n");
  return dir;
}

function readLayer(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, "configs", name), "utf8"));
}

async function listen(server) {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return server.address().port;
}

// undici keep-alive: without closeAllConnections() server.close() never
// resolves and the suite hangs (same lesson as scorers.test.mjs).
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(r => server.close(() => r()));
}

async function api(port, method, p, { token = TOKEN, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML responses */ }
  return { code: res.status, json, text };
}

describe("config-server", () => {
  const dir = mkFixture();
  let server, port;

  before(async () => {
    server = createConfigServer({ configDir: dir, stateDir: path.join(dir, "state"), logsDir: path.join(dir, "logs"), token: TOKEN });
    port = await listen(server);
  });

  after(async () => {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("auth", () => {
    test("GET /health is open", async () => {
      const r = await api(port, "GET", "/health", { token: null });
      assert.equal(r.code, 200);
      assert.equal(r.json.ok, true);
    });

    test("missing token -> 401, wrong token -> 401", async () => {
      assert.equal((await api(port, "GET", "/config", { token: null })).code, 401);
      assert.equal((await api(port, "GET", "/config", { token: "nope" })).code, 401);
      assert.equal((await api(port, "POST", "/action", { token: null, body: {} })).code, 401);
    });
  });

  describe("reads", () => {
    test("GET /config returns the curated view of the merged config", async () => {
      const r = await api(port, "GET", "/config");
      assert.equal(r.code, 200);
      assert.equal(r.json.tracks.alpha.label, "Alpha Track");
      assert.deepEqual(r.json.tracks.alpha.keywords, ["alpha"]);
      assert.deepEqual(r.json.sources, { remotive: { enabled: true }, remoteok: { enabled: false } });
      assert.deepEqual(r.json.watchedCompanies.greenhouse.riotgames, "Riot Games");
      assert.equal(r.json.blocklist.enabled, false);
      assert.equal(r.json.recency.maxAgeDays, null);
      assert.equal(r.json.selection.limit, 40); // DEFAULTS — production.json is {}
    });
  });

  describe("write actions", () => {
    test("set_track_keywords writes the BASE layer and warns about prompt re-cache", async () => {
      const r = await api(port, "POST", "/action", { body: { action: "set_track_keywords", params: { track: "alpha", keywords: ["alpha", "beta"] } } });
      assert.equal(r.code, 200);
      assert.match(r.json.note, /re-cache|slower/);
      assert.deepEqual(readLayer(dir, "base.json").tracks.alpha.keywords, ["alpha", "beta"]);
      // production layer untouched
      assert.deepEqual(readLayer(dir, "production.json"), {});
    });

    test("block_company auto-enables the blocklist filter in the PRODUCTION layer", async () => {
      const r = await api(port, "POST", "/action", { body: { action: "block_company", params: { company: "Acme Corp" } } });
      assert.equal(r.code, 200);
      const prod = readLayer(dir, "production.json");
      assert.deepEqual(prod.filters, ["keyword-match", "blocklist"]);
      assert.deepEqual(prod.filterConfig.blocklist.companies, ["Acme Corp"]);
      // case-insensitive dedupe on second block
      await api(port, "POST", "/action", { body: { action: "block_company", params: { company: "acme corp" } } });
      assert.equal(readLayer(dir, "production.json").filterConfig.blocklist.companies.length, 1);
    });

    test("set_recency_days enables the filter; set_recency_off removes it (null is not 'off')", async () => {
      await api(port, "POST", "/action", { body: { action: "set_recency_days", params: { days: 7 } } });
      let prod = readLayer(dir, "production.json");
      assert.ok(prod.filters.includes("recency"));
      assert.equal(prod.filterConfig.recency.maxAgeDays, 7);
      await api(port, "POST", "/action", { body: { action: "set_recency_off" } });
      prod = readLayer(dir, "production.json");
      assert.ok(!prod.filters.includes("recency"));
    });

    test("set_daily_limit writes selection.limit; out-of-range rejected", async () => {
      const ok = await api(port, "POST", "/action", { body: { action: "set_daily_limit", params: { limit: 25 } } });
      assert.equal(ok.code, 200);
      assert.equal(readLayer(dir, "production.json").selection.limit, 25);
      assert.equal((await api(port, "POST", "/action", { body: { action: "set_daily_limit", params: { limit: 41 } } })).code, 400);
      assert.equal((await api(port, "POST", "/action", { body: { action: "set_daily_limit", params: { limit: 0 } } })).code, 400);
    });

    test("toggle_source writes the BASE layer; unknown source lists the known ones", async () => {
      const ok = await api(port, "POST", "/action", { body: { action: "toggle_source", params: { source: "remoteok", enabled: true } } });
      assert.equal(ok.code, 200);
      assert.equal(readLayer(dir, "base.json").sources.remoteok.enabled, true);
      const bad = await api(port, "POST", "/action", { body: { action: "toggle_source", params: { source: "myspace", enabled: true } } });
      assert.equal(bad.code, 400);
      assert.match(bad.json.error, /remotive/);
    });

    test("add_watched_company writes ats.<family>.<slug>; duplicates and bad families rejected", async () => {
      const ok = await api(port, "POST", "/action", { body: { action: "add_watched_company", params: { ats: "ashby", slug: "ramp", label: "Ramp" } } });
      assert.equal(ok.code, 200);
      assert.equal(readLayer(dir, "base.json").ats.ashby.ramp.label, "Ramp");
      assert.equal((await api(port, "POST", "/action", { body: { action: "add_watched_company", params: { ats: "greenhouse", slug: "riotgames", label: "x" } } })).code, 400);
      assert.equal((await api(port, "POST", "/action", { body: { action: "add_watched_company", params: { ats: "indeed", slug: "x", label: "x" } } })).code, 400);
    });
  });

  describe("validation-before-disk", () => {
    test("bad regex -> 400, production.json unchanged on disk", async () => {
      const before = fs.readFileSync(path.join(dir, "configs", "production.json"), "utf8");
      const r = await api(port, "POST", "/action", { body: { action: "block_title_pattern", params: { pattern: "(" } } });
      assert.equal(r.code, 400);
      assert.match(r.json.error, /not a valid regular expression/i);
      assert.equal(fs.readFileSync(path.join(dir, "configs", "production.json"), "utf8"), before);
    });

    test("unknown track -> 400 listing known tracks", async () => {
      const r = await api(port, "POST", "/action", { body: { action: "set_track_weight", params: { track: "nope", weight: 3 } } });
      assert.equal(r.code, 400);
      assert.match(r.json.error, /alpha/);
    });

    test("unknown action -> 400 with the available list", async () => {
      const r = await api(port, "POST", "/action", { body: { action: "format_c_drive" } });
      assert.equal(r.code, 400);
      assert.match(r.json.error, /set_track_keywords/);
    });
  });

  describe("backups + audit + restore", () => {
    test("every write snapshots both layers and appends an audit line", async () => {
      const backupDir = path.join(dir, "configs", ".backups");
      const snapshots = fs.readdirSync(backupDir).filter(f => f.endsWith(".json"));
      assert.ok(snapshots.length >= 1);
      const audit = fs.readFileSync(path.join(backupDir, "audit.jsonl"), "utf8").trim().split("\n");
      assert.ok(audit.length >= 1);
      const entry = JSON.parse(audit[audit.length - 1]);
      assert.equal(entry.action, "add_watched_company");
      assert.ok(entry.backup);
    });

    test("restore_backup genuinely undoes the action it snapshotted", async () => {
      // The snapshot taken by a write must contain the PRE-WRITE state, and
      // restoring it must actually change the file back. (Both halves of this
      // once passed vacuously when snapshots captured the post-write state —
      // restore wrote identical bytes, and the assertion compared the file to
      // itself.)
      const pre = readLayer(dir, "production.json");
      assert.ok(!pre.filterConfig?.blocklist?.companies?.includes("Restore Probe Ltd"));

      const r1 = await api(port, "POST", "/action", { body: { action: "block_company", params: { company: "Restore Probe Ltd" } } });
      assert.equal(r1.code, 200);
      const snapshot = fs.readdirSync(path.join(dir, "configs", ".backups"))
        .filter(f => f.endsWith(".json")).sort().at(-1);
      // snapshot content = pre-write state, not the mutated layers
      const snapObj = JSON.parse(fs.readFileSync(path.join(dir, "configs", ".backups", snapshot), "utf8"));
      assert.ok(!snapObj.production.filterConfig.blocklist.companies.includes("Restore Probe Ltd"));

      const r2 = await api(port, "POST", "/action", { body: { action: "restore_backup", params: { file: snapshot } } });
      assert.equal(r2.code, 200);
      const restored = readLayer(dir, "production.json");
      assert.ok(!restored.filterConfig.blocklist.companies.includes("Restore Probe Ltd"), "restore must remove the blocked company");
      // path climbing refused
      assert.equal((await api(port, "POST", "/action", { body: { action: "restore_backup", params: { file: "../base.json" } } })).code, 400);
    });

    test("list_backups returns snapshot names, newest first", async () => {
      const r = await api(port, "POST", "/action", { body: { action: "list_backups" } });
      assert.equal(r.code, 200);
      assert.ok(Array.isArray(r.json.backups));
      assert.ok(r.json.backups.length >= 1);
    });
  });

  describe("status + html", () => {
    test("GET /status reads today's digest, pending and seen from the state dir", async () => {
      fs.writeFileSync(path.join(dir, "state", `digest-${todayStamp()}.json`), JSON.stringify([
        { id: "a1", track: "alpha", score: 90, one_line: "fit", fit_notes: "n", _posting: { id: "a1", company: "ACME", title: "Alpha Engineer <script>", url: "https://x/a1" } },
      ]));
      fs.writeFileSync(path.join(dir, "state", "seen.json"), JSON.stringify(["remotive:1", "remotive:2"]));
      fs.writeFileSync(path.join(dir, "state", "pending-colibri.json"), JSON.stringify([{ source: "hn", id: "3" }]));
      fs.writeFileSync(path.join(dir, "logs", "run-2026-09-06.log"), "line1\nline2\n");

      const r = await api(port, "GET", "/status");
      assert.equal(r.code, 200);
      assert.equal(r.json.pendingColibri, 1);
      assert.equal(r.json.seenPostings, 2);
      assert.equal(r.json.digest.length, 1);
      assert.equal(r.json.digest[0].track_label, "Alpha Track");
      assert.deepEqual(r.json.lastLogLines, ["line1", "line2"]);
    });

    test("GET / HTML-escapes posting titles (injection guard)", async () => {
      const r = await api(port, "GET", `/?token=${TOKEN}`);
      assert.equal(r.code, 200);
      assert.ok(!r.text.includes("<script>"));
      assert.ok(r.text.includes("&lt;script&gt;"));
    });
  });
});
