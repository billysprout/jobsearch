// scorers.test.mjs — pipeline stage behavior, including the scorer chain's
// failure-mode protocol against a MOCK colibri SSE server on an ephemeral
// port (no network, no model):
//   success            → rankings + onRanked(sourcePostings), missed []
//   HTTP 500 / offline → ctx.deferred, NEVER heuristic-scored here
//   malformed JSON     → `missed` (falls to the next scorer), NOT deferred
//   id-trust           → chunkSize 1 overrides mangled colibri echo ids
//   pre-gate split     → threshold ≥ splits gate/colibri; null disables
// and the registry (name resolution, terminal-scorer validation).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { DEFAULTS, deepMerge, ConfigError } from "../config.mjs";
import { validateChains, resolveFilter, resolveScorer } from "../pipeline/registry.mjs";

// --- Test config + data -----------------------------------------------------

// Weight 5 so a single alpha-keyword hit scores 75 (>= the default 70 gate)
// — makes the gate split easy to arrange without 5 distinct keywords.
const TRACKS = {
  alpha: { label: "Alpha", description: "alpha work", weight: 5, keywords: ["alpha", "kubernetes"] },
  beta: { label: "Beta", description: "beta work", weight: 0.5, keywords: ["beta"] },
};

function mkPosting(id, bodyText) {
  return { source: "test", id, company: "ACME", title: "Engineer", location: "LA", salary: "", url: `https://x/${id}`, bodyText };
}

// Nested overrides deep-merge (a `colibri: { chunkSize: 2 }` override must
// not wipe baseUrl) — same semantics as profile layering.
function testConfig(baseUrl, overrides = {}) {
  const base = deepMerge(
    { tracks: TRACKS, colibri: { baseUrl, mcpHealthUrl: null, timeoutMs: 2000 } },
    overrides,
  );
  return deepMerge(structuredClone(DEFAULTS), base);
}

// Records ctx calls so tests can assert the persist/defer protocol.
function makeCtx(cfg, { first = false, overrides = {} } = {}) {
  const calls = { onRanked: [], deferred: [] };
  const ctx = {
    config: cfg,
    dryRun: true,
    first,
    onRanked: async (rankings, sourcePostings) => calls.onRanked.push({ rankings, sourcePostings }),
    defer: postings => calls.deferred.push(...postings),
    pendingSize: () => 42,
    ...overrides,
  };
  return { ctx, calls };
}

// --- Mock colibri SSE server ------------------------------------------------

// `handler(res, requestBody)` writes the response. Returns { baseUrl, done }.
function startMockColibri(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push(body);
    await handler(res, body);
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        // undici keeps its sockets alive after the response — server.close()
        // alone would wait on them forever, so destroy them first.
        close: () => {
          server.closeAllConnections();
          return new Promise(r => server.close(() => r()));
        },
      });
    });
  });
}

// One SSE stream carrying `content` as a single delta, plus a usage frame.
// Frames must be "\n\n"-terminated — colibri.mjs reconstructs content by
// splitting the raw body on newlines and keeping the "data: " lines.
function sseContent(res, content) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`,
    "data: [DONE]",
  ];
  res.end(frames.map(f => `${f}\n\n`).join(""));
}

// --- colibri-rank scorer -----------------------------------------------------

describe("scorers/colibri-rank", () => {
  test("success: ranks the chunk, attaches _posting, reports no misses", async () => {
    const mock = await startMockColibri((res) =>
      sseContent(res, JSON.stringify([{ id: "whatever", score: 82, track: "beta", one_line: "good", fit_notes: "solid" }])));
    try {
      const cfg = testConfig(mock.baseUrl);
      const scorer = resolveScorer("colibri");
      const p = mkPosting("p0", "beta stuff");
      const { ctx, calls } = makeCtx(cfg);

      const result = await scorer.score([p], scorer.init(cfg), ctx);

      assert.equal(result.rankings.length, 1);
      assert.equal(result.rankings[0].score, 82);
      assert.equal(result.rankings[0]._posting.company, "ACME"); // real posting attached
      assert.deepEqual(result.missed, []);
      assert.deepEqual(result.deferred, []);
      assert.equal(result.online, true);
      assert.equal(calls.onRanked.length, 1);
      assert.deepEqual(calls.onRanked[0].sourcePostings.map(x => x.id), ["p0"]);
    } finally {
      await mock.close();
    }
  });

  test("HTTP 500: deferred to pending queue, NOT scored, online=false", async () => {
    const mock = await startMockColibri((res) => { res.writeHead(500); res.end("boom"); });
    try {
      const cfg = testConfig(mock.baseUrl);
      const scorer = resolveScorer("colibri");
      const p = mkPosting("p0", "beta stuff");
      const { ctx, calls } = makeCtx(cfg);

      const result = await scorer.score([p], scorer.init(cfg), ctx);

      assert.deepEqual(result.rankings, []);
      assert.deepEqual(result.missed, []); // an outage must NOT fall through to the next scorer
      assert.deepEqual(result.deferred.map(x => x.id), ["p0"]);
      assert.equal(result.online, false);
      assert.deepEqual(calls.deferred.map(x => x.id), ["p0"]);
      assert.deepEqual(calls.onRanked, []); // nothing published
    } finally {
      await mock.close();
    }
  });

  test("malformed JSON: falls through as `missed` (next scorer's problem), not deferred", async () => {
    const mock = await startMockColibri((res) => sseContent(res, "I am not json at all"));
    try {
      const cfg = testConfig(mock.baseUrl);
      const scorer = resolveScorer("colibri");
      const p = mkPosting("p0", "beta stuff");
      const { ctx, calls } = makeCtx(cfg);

      const result = await scorer.score([p], scorer.init(cfg), ctx);

      assert.deepEqual(result.rankings, []);
      assert.deepEqual(result.deferred, []); // not an outage — no retry queue
      assert.deepEqual(result.missed.map(x => x.id), ["p0"]);
      assert.equal(result.online, true); // colibri answered, just uselessly
      assert.deepEqual(calls.deferred, []);
      // colibri-rank does emit onRanked([], chunk) for such a chunk, but the
      // orchestrator's persistAndPublish is a no-op on empty rankings — what
      // matters is nothing non-empty gets published.
      assert.deepEqual(calls.onRanked.filter(c => c.rankings.length), []);
    } finally {
      await mock.close();
    }
  });

  test("id-trust: at chunkSize 1 a mangled colibri echo id is overridden", async () => {
    const mock = await startMockColibri((res) =>
      sseContent(res, JSON.stringify([{ id: "gh-999", score: 50, track: "none", one_line: "x", fit_notes: "y" }])));
    try {
      const cfg = testConfig(mock.baseUrl); // chunkSize 1 from DEFAULTS
      const scorer = resolveScorer("colibri");
      const p = mkPosting("gh-riotgames-7312899", "beta stuff");
      const { ctx } = makeCtx(cfg);

      const result = await scorer.score([p], scorer.init(cfg), ctx);

      // Production observed colibri echoing "gh-riotgames-…" as "gh-…" — the
      // single-posting chunk's real id wins, so the real posting attaches.
      assert.equal(result.rankings[0].id, "gh-riotgames-7312899");
      assert.equal(result.rankings[0]._posting.company, "ACME");
    } finally {
      await mock.close();
    }
  });

  test("no id-trust at chunkSize 2: mangled id gets a placeholder _posting, sibling is missed", async () => {
    const mock = await startMockColibri((res) =>
      sseContent(res, JSON.stringify([{ id: "TOTALLY-WRONG", score: 50, track: "none", one_line: "x", fit_notes: "y" }])));
    try {
      const cfg = testConfig(mock.baseUrl, { colibri: { chunkSize: 2 } });
      const scorer = resolveScorer("colibri");
      const p0 = mkPosting("p0", "beta stuff");
      const p1 = mkPosting("p1", "more beta");
      const { ctx } = makeCtx(cfg);

      const result = await scorer.score([p0, p1], scorer.init(cfg), ctx);

      assert.equal(result.rankings.length, 1);
      assert.equal(result.rankings[0].id, "TOTALLY-WRONG"); // ambiguity: no override
      assert.equal(result.rankings[0]._posting.company, "?"); // placeholder fallback
      // Both postings fall through as missed: the ranking's mangled id
      // matches neither, so the chunk effectively ranked nothing — this is
      // the data-loss mode the chunkSize-1 id-trust override prevents.
      assert.deepEqual(result.missed.map(x => x.id), ["p0", "p1"]);
    } finally {
      await mock.close();
    }
  });
});

// --- keyword-gate scorer -----------------------------------------------------

describe("scorers/keyword-gate", () => {
  test("splits at the threshold: high-confidence ranked now, rest passed as missed", async () => {
    const cfg = testConfig("http://127.0.0.1:1"); // gate must never call colibri
    const scorer = resolveScorer("keyword-gate");
    const strong = mkPosting("strong", "alpha kubernetes"); // 2 hits * 15 * w5 = 100
    const weak = mkPosting("weak", "beta stuff");           // 1 hit * 15 * 0.5 = 7.5
    const { ctx, calls } = makeCtx(cfg);

    const result = await scorer.score([strong, weak], scorer.init(cfg), ctx);

    assert.deepEqual(result.rankings.map(r => r.id), ["strong"]);
    assert.deepEqual(result.missed.map(p => p.id), ["weak"]);
    assert.match(result.rankings[0].fit_notes, /skipped colibri, high-confidence keyword match \(>= 70\)/);
    assert.equal(result.rankings[0].score, 100);
    assert.deepEqual(calls.onRanked[0].sourcePostings.map(p => p.id), ["strong"]);
  });

  test("threshold null disables the gate entirely (everything passes through)", async () => {
    const cfg = testConfig("http://127.0.0.1:1", { colibri: { heuristicSkipThreshold: null } });
    const scorer = resolveScorer("keyword-gate");
    const p = mkPosting("strong", "alpha kubernetes");
    const { ctx, calls } = makeCtx(cfg);

    const result = await scorer.score([p], scorer.init(cfg), ctx);

    assert.deepEqual(result.rankings, []);
    assert.deepEqual(result.missed.map(x => x.id), ["strong"]);
    assert.deepEqual(calls.onRanked, []);
  });

  test("nothing above the threshold: no log-worthy work, no rankings, all missed", async () => {
    const cfg = testConfig("http://127.0.0.1:1");
    const scorer = resolveScorer("keyword-gate");
    const { ctx, calls } = makeCtx(cfg);

    const result = await scorer.score([mkPosting("weak", "beta stuff")], scorer.init(cfg), ctx);

    assert.deepEqual(result.rankings, []);
    assert.deepEqual(calls.onRanked, []);
    assert.deepEqual(result.missed.map(x => x.id), ["weak"]);
  });
});

// --- keyword-heuristic scorer (terminal) --------------------------------------

describe("scorers/keyword-heuristic", () => {
  test("first in chain: publishes rankings with sourcePostings (marks seen)", async () => {
    const cfg = testConfig("http://127.0.0.1:1");
    const scorer = resolveScorer("keyword-heuristic");
    const p = mkPosting("p0", "alpha kubernetes");
    const { ctx, calls } = makeCtx(cfg, { first: true });

    const result = await scorer.score([p], scorer.init(cfg), ctx);

    assert.equal(result.rankings[0].score, 100);
    assert.equal(result.rankings[0].track, "alpha");
    assert.deepEqual(result.missed, []); // terminal
    assert.deepEqual(calls.onRanked[0].sourcePostings.map(x => x.id), ["p0"]);
  });

  test("not first (malformed-gap fill): publishes with empty sourcePostings (no re-mark)", async () => {
    const cfg = testConfig("http://127.0.0.1:1");
    const scorer = resolveScorer("keyword-heuristic");
    const p = mkPosting("p0", "beta stuff");
    const { ctx, calls } = makeCtx(cfg, { first: false });

    const result = await scorer.score([p], scorer.init(cfg), ctx);

    assert.equal(result.rankings[0].track, "beta");
    assert.deepEqual(calls.onRanked[0].sourcePostings, []); // already seen upstream
  });
});

// --- Full default chain against the mock (the parity-critical control flow) ---

describe("default scorer chain", () => {
  test("gate -> colibri -> heuristic: one of each failure mode in a single run", async () => {
    const mock = await startMockColibri((res, body) => {
      const prompt = body.messages[1].content;
      if (prompt.includes("[id: \"good\"]")) {
        sseContent(res, JSON.stringify([{ id: "good", score: 82, track: "beta", one_line: "good", fit_notes: "solid" }]));
      } else {
        sseContent(res, "{{{ not json"); // the "gap" posting gets a malformed reply
      }
    });
    try {
      const cfg = testConfig(mock.baseUrl); // default scorers: gate -> colibri -> heuristic
      const postings = [
        mkPosting("strong", "alpha kubernetes"), // gate: 100 >= 70
        mkPosting("good", "beta stuff"),         // colibri: 7.5 < 70, replies fine
        mkPosting("gap", "boring text"),         // colibri: 0, replies malformed
      ];

      let remaining = postings;
      const all = [];
      const seenSource = [];
      for (let i = 0; i < cfg.scorers.length; i++) {
        const scorer = resolveScorer(cfg.scorers[i]);
        const { ctx } = makeCtx(cfg, { first: i === 0, overrides: {
          // Mirrors the orchestrator's persistAndPublish guard: empty
          // rankings are a no-op (colibri emits onRanked([], chunk) for a
          // chunk that succeeded but parsed to nothing).
          onRanked: async (rankings, sourcePostings) => {
            if (rankings.length) seenSource.push(sourcePostings.map(p => p.id));
          },
        } });
        const result = await scorer.score(remaining, scorer.init(cfg), ctx);
        all.push(...result.rankings);
        remaining = result.missed;
      }

      assert.deepEqual(remaining, []); // terminal scorer consumed everything
      assert.deepEqual(all.map(r => [r.id, r.score, r.track]), [
        ["strong", 100, "alpha"],  // pre-gate
        ["good", 82, "beta"],      // colibri
        ["gap", 0, "none"],        // heuristic fill
      ]);
      assert.deepEqual(seenSource, [["strong"], ["good"], []]);
    } finally {
      await mock.close();
    }
  });
});

// --- registry -----------------------------------------------------------------

describe("pipeline/registry", () => {
  test("unknown scorer name lists the known stages", () => {
    assert.throws(() => resolveScorer("nope"), e => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /unknown scorer stage: "nope"/);
      assert.match(e.message, /"keyword-heuristic"/);
      return true;
    });
  });

  test("unknown filter name throws ConfigError", () => {
    assert.throws(() => resolveFilter("nope"), ConfigError);
  });

  test("validateChains: empty scorers chain throws", () => {
    const cfg = testConfig("http://127.0.0.1:1", { filters: [], scorers: [] });
    assert.throws(() => validateChains(cfg), /scorers chain is empty/);
  });

  test("validateChains: non-terminal last scorer throws with the known terminal list", () => {
    const cfg = testConfig("http://127.0.0.1:1", { filters: [], scorers: ["colibri"] });
    assert.throws(() => validateChains(cfg), /must be terminal[\s\S]*"keyword-heuristic"/);
  });

  test("validateChains: the default chain from DEFAULTS is valid", () => {
    const cfg = testConfig("http://127.0.0.1:1");
    assert.doesNotThrow(() => validateChains(cfg));
  });
});
