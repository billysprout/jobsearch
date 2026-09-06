// filters.test.mjs — the first-party opt-in filter stages (recency,
// blocklist): init validation, keep/drop behavior, and byReason bookkeeping.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ConfigError } from "../config.mjs";
import * as recency from "../filters/recency.mjs";
import * as blocklist from "../filters/blocklist.mjs";

function mkPosting(overrides = {}) {
  return { source: "test", id: "p", company: "ACME", title: "Engineer", url: "https://x", location: "", salary: "", bodyText: "", ...overrides };
}

describe("filters/recency", () => {
  // postedAt relative to test-run time: -2d, -90d, none.
  const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const postings = [
    mkPosting({ id: "fresh", postedAt: daysAgo(2) }),
    mkPosting({ id: "stale", postedAt: daysAgo(90) }),
    mkPosting({ id: "undated" }),
  ];

  test("drops postings older than maxAgeDays, keeps fresh ones", () => {
    const params = recency.init({ filterConfig: { recency: { maxAgeDays: 30 } } });
    const result = recency.apply(postings, params);
    assert.deepEqual(result.kept.map(p => p.id), ["fresh", "undated"]); // undated kept by default
    assert.deepEqual(result.byReason, { "too-old": 1, "unknown-date": 0 });
  });

  test("keepUnknownDate: false drops postings without a parseable date", () => {
    const params = recency.init({ filterConfig: { recency: { maxAgeDays: 30, keepUnknownDate: false } } });
    const result = recency.apply(postings, params);
    assert.deepEqual(result.kept.map(p => p.id), ["fresh"]);
    assert.deepEqual(result.byReason, { "too-old": 1, "unknown-date": 1 });
  });

  test("unparseable date strings count as unknown, not old", () => {
    const params = recency.init({ filterConfig: { recency: { maxAgeDays: 30 } } });
    const result = recency.apply([mkPosting({ postedAt: "not a date" })], params);
    assert.equal(result.kept.length, 1);
    assert.equal(result.byReason["unknown-date"], 0); // kept -> not counted as dropped
  });

  test("bad maxAgeDays throws ConfigError from init", () => {
    assert.throws(() => recency.init({ filterConfig: { recency: { maxAgeDays: 0 } } }), ConfigError);
    assert.throws(() => recency.init({ filterConfig: { recency: { maxAgeDays: -5 } } }), ConfigError);
    assert.throws(() => recency.init({ filterConfig: { recency: { maxAgeDays: "soon" } } }), ConfigError);
  });

  test("defaults apply when the filterConfig slice is absent", () => {
    const params = recency.init({});
    assert.equal(params.maxAgeDays, 30);
    assert.equal(params.keepUnknownDate, true);
  });
});

describe("filters/blocklist", () => {
  test("drops postings by company (case-insensitive) and by title regex", () => {
    const params = blocklist.init({ filterConfig: { blocklist: {
      companies: ["Talent Aadhar"],
      titlePatterns: ["^Head of "],
    } } });
    const result = blocklist.apply([
      mkPosting({ id: "co", company: "talent aadhar", title: "Engineer" }),
      mkPosting({ id: "title", company: "Good Co", title: "Head of Remote Talent" }),
      mkPosting({ id: "ok", company: "Good Co", title: "Software Engineer" }),
    ], params);
    assert.deepEqual(result.kept.map(p => p.id), ["ok"]);
    assert.deepEqual(result.byReason, { "blocklisted-company": 1, "blocklisted-title": 1 });
  });

  test("regex flags are case-insensitive and match mid-title", () => {
    const params = blocklist.init({ filterConfig: { blocklist: { titlePatterns: ["senior"] } } });
    const result = blocklist.apply([mkPosting({ title: "Staff/Senior Engineer" })], params);
    assert.deepEqual(result.kept, []);
  });

  test("non-compiling titlePatterns throw ConfigError at init", () => {
    assert.throws(
      () => blocklist.init({ filterConfig: { blocklist: { titlePatterns: ["[unclosed"] } } }),
      e => e instanceof ConfigError && /not a valid regex/.test(e.message),
    );
  });

  test("bad companies shape throws ConfigError", () => {
    assert.throws(() => blocklist.init({ filterConfig: { blocklist: { companies: [42] } } }), ConfigError);
  });

  test("empty blocklist passes everything through", () => {
    const params = blocklist.init({});
    const postings = [mkPosting(), mkPosting({ id: "q" })];
    const result = blocklist.apply(postings, params);
    assert.deepEqual(result.kept, postings);
  });
});
