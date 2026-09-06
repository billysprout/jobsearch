// render.test.mjs — pipeline/render.mjs bits with cross-file contracts:
// renderSummaryJson's track_label (consumed by the single-file-deployed
// digest-notify.mjs, which must never need its own taxonomy copy).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderSummaryJson } from "../pipeline/render.mjs";

const TRACKS = {
  alpha: { label: "Alpha Track", keywords: ["alpha"], description: "a" },
  beta: { label: "Beta Track", keywords: ["beta"], description: "b" },
};

function mkRanking(id, track, score) {
  return {
    id, track, score,
    one_line: "x", fit_notes: "y",
    _posting: { id, source: "test", company: "ACME", title: "T", location: "", salary: "", url: "https://x", bodyText: "" },
  };
}

describe("pipeline/render: renderSummaryJson", () => {
  test("items carry track_label derived from config.tracks", () => {
    const out = renderSummaryJson([mkRanking("a", "alpha", 80)], 5, TRACKS);
    assert.equal(out.length, 1);
    assert.equal(out[0].track_label, "Alpha Track");
  });

  test("falls back to the track key for an untracked track name", () => {
    const out = renderSummaryJson([mkRanking("a", "mystery", 80)], 5, TRACKS);
    assert.equal(out[0].track_label, "mystery");
  });

  test("topNPerTrack caps each track; none-track items are excluded", () => {
    const rankings = [
      mkRanking("a1", "alpha", 90), mkRanking("a2", "alpha", 80), mkRanking("a3", "alpha", 70),
      mkRanking("b1", "beta", 60),
      mkRanking("n1", "none", 99),
    ];
    const out = renderSummaryJson(rankings, 2, TRACKS);
    assert.deepEqual(out.map(r => r.id), ["a1", "a2", "b1"]);
    assert.equal(out.find(r => r.track === "alpha").track_label, "Alpha Track");
  });
});
