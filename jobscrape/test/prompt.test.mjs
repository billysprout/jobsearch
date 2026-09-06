// prompt.test.mjs — the KV-cache guard.
//
// buildSystemPrompt() must reproduce the HISTORICAL hardcoded SYSTEM_PROMPT
// byte-for-byte for the current production tracks (alphabetical esports /
// it-devops / producer-pm). Colibri caches prompts by prefix: one changed
// byte re-prefills every colibri call until the cache turns over again
// (minutes per chunk). If this test fails, either you broke the template or
// you deliberately changed the prompt — in which case update the literal
// here, understand that you're spending a full re-prefill, and say so in the
// commit message.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt, trackWhitelist, sortedTrackKeys } from "../pipeline/prompt.mjs";

// The literal that shipped hardcoded in colibri.mjs until the taxonomy moved
// into config.tracks. Keys are deliberately declared NON-alphabetical here to
// prove the generator sorts them (and is therefore order-stable regardless of
// how configs/base.json happens to order its tracks).
const HISTORICAL_TRACKS = {
  "producer-pm": {
    label: "Producer / Project Management",
    description: "producer, PM, TPM, delivery, agile",
  },
  esports: {
    label: "Esports / Gaming Ops",
    description: "tournament ops, team management, broadcast, competitive gaming",
  },
  "it-devops": {
    label: "IT / Sysadmin / DevOps",
    description: "infrastructure, SRE, cloud, sysadmin, security",
  },
};

const HISTORICAL_PROMPT = `You are a job-posting analyst. Given a batch of job postings, score each one against three role tracks:

1. "esports" — Esports / Gaming Ops (tournament ops, team management, broadcast, competitive gaming)
2. "it-devops" — IT / Sysadmin / DevOps (infrastructure, SRE, cloud, sysadmin, security)
3. "producer-pm" — Producer / Project Management (producer, PM, TPM, delivery, agile)

For EACH posting, return a JSON object with:
- "id": the exact id string from the input (do NOT change it)
- "score": 0-100 (how strong a fit for ANY of the three tracks)
- "track": one of "esports", "it-devops", "producer-pm", or "none"
- "one_line": one sentence explaining why it's relevant (or why it's not)
- "fit_notes": 2-3 bullet points on key fit factors

Return ONLY a JSON array of these objects, one per posting, in the same order as input. No markdown fences, no extra text.`;

test("generated prompt is byte-identical to the historical literal (KV-cache guard)", () => {
  const generated = buildSystemPrompt(HISTORICAL_TRACKS);
  assert.equal(Buffer.compare(Buffer.from(generated, "utf8"), Buffer.from(HISTORICAL_PROMPT, "utf8")), 0);
});

test("generated prompt matches the real repo config's tracks byte-for-byte too", async () => {
  const { loadConfig } = await import("../config.mjs");
  const cfg = loadConfig();
  assert.equal(buildSystemPrompt(cfg.tracks), HISTORICAL_PROMPT);
});

test("track keys sort alphabetically regardless of config order", () => {
  assert.deepEqual(sortedTrackKeys(HISTORICAL_TRACKS), ["esports", "it-devops", "producer-pm"]);
});

test("trackWhitelist is sorted keys + none, in that order", () => {
  assert.deepEqual(trackWhitelist(HISTORICAL_TRACKS), ["esports", "it-devops", "producer-pm", "none"]);
});

test("em-dashes in track lines are U+2014 (stripEmDash must never see prompts, but don't degrade them either)", () => {
  assert.ok(buildSystemPrompt(HISTORICAL_TRACKS).includes(`"esports" — Esports`));
});

test("count words: one/two/three, digits beyond the table", () => {
  const one = buildSystemPrompt({ solo: HISTORICAL_TRACKS.esports });
  assert.match(one, /against one role tracks:/);
  const four = buildSystemPrompt({
    d: HISTORICAL_TRACKS.esports, a: HISTORICAL_TRACKS["it-devops"],
    c: HISTORICAL_TRACKS["producer-pm"], b: { label: "X", description: "y" },
  });
  assert.match(four, /against four role tracks:/);
  assert.match(four, /^2\. "b" — X \(y\)$/m, "tracks sort alphabetically (b is second of a,b,c,d)");
});
