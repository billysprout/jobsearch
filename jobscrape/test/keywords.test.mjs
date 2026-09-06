// keywords.test.mjs — word-boundary keyword matching. The aws/laws case is
// the historical regression: short keywords used to substring-match inside
// unrelated words, turning retail/admin postings into false it-devops hits.
// Run: npm test   (node --test test/)

import { test } from "node:test";
import assert from "node:assert/strict";

import { keywordMatches, firstTrackMatch, bestTrackScore } from "../keywords.mjs";

test("aws does not match inside unrelated words", () => {
  assert.equal(keywordMatches("liability laws and regulations", "aws"), false);
  assert.equal(keywordMatches("it withdraws from the market", "aws"), false);
  assert.equal(keywordMatches("jaws of the clamp", "aws"), false);
});

test("aws matches as a whole word, case-insensitively", () => {
  assert.equal(keywordMatches("Experience with AWS and terraform", "aws"), true);
  assert.equal(keywordMatches("(aws) required", "aws"), true);
});

test("multi-word phrases still match", () => {
  assert.equal(keywordMatches("site reliability engineer role", "site reliability"), true);
  assert.equal(keywordMatches("tournament operations", "tournament"), true);
});

test("word boundary holds against trailing punctuation and plurals", () => {
  assert.equal(keywordMatches("esports, fighting games", "esports"), true);
  // "esport" should not match inside "esports" (regex lookahead blocks the
  // trailing 's') — that's why the config lists both spellings.
  assert.equal(keywordMatches("esports events", "esport"), false);
  assert.equal(keywordMatches("an esport title", "esport"), true);
});

test("firstTrackMatch returns the first declared track that matches", () => {
  const tracks = {
    first: { keywords: ["shared", "only-first"] },
    second: { keywords: ["shared", "only-second"] },
  };
  assert.deepEqual(firstTrackMatch("talks about shared infra", tracks), { track: "first", keyword: "shared" });
  assert.deepEqual(firstTrackMatch("only-second here", tracks), { track: "second", keyword: "only-second" });
  assert.equal(firstTrackMatch("nothing relevant", tracks), null);
});

test("bestTrackScore: distinct hits * 15 * weight", () => {
  const tracks = { t: { keywords: ["a", "b", "c"], weight: 1 } };
  assert.equal(bestTrackScore("a b", tracks).score, 30);
  assert.equal(bestTrackScore("a a a b", tracks).score, 30, "duplicate mentions count once");
});

test("bestTrackScore caps at 100", () => {
  const tracks = { t: { keywords: Array.from({ length: 8 }, (_, i) => `kw${i}`), weight: 1 } };
  assert.equal(bestTrackScore("kw0 kw1 kw2 kw3 kw4 kw5 kw6 kw7", tracks).score, 100);
});

test("bestTrackScore applies track weight and picks the best track", () => {
  const tracks = {
    light: { keywords: ["alpha"], weight: 0.8 },
    heavy: { keywords: ["beta"], weight: 1.0 },
  };
  const r = bestTrackScore("alpha beta", tracks);
  assert.equal(r.track, "heavy");
  assert.equal(r.score, 15);
});

test("bestTrackScore returns none/0 when nothing matches", () => {
  assert.deepEqual(bestTrackScore("nothing here", { t: { keywords: ["x"] } }), { track: "none", score: 0 });
});
