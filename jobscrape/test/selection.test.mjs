// selection.test.mjs — pipeline/selection.mjs: source priority, the
// round-robin company interleave (the Riot-hyperfocus regression),
// pending-first capping, and the reservedSlots feature.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { sourcePriorityOf, interleaveByCompany, buildCandidates } from "../pipeline/selection.mjs";

const SELECTION = {
  limit: 10,
  perCompanyMax: 3,
  sourcePriorities: { greenhouse: 0, lever: 0, remotive: 1, hn: 1, remoteok: 2, wwr: 2 },
  unknownSourcePriority: 3,
  reservedSlots: 0,
  reservedSourcePriority: 1,
};

function mkPosting(source, company, title) {
  return { source, id: `${source}-${company}-${title}`, company, title, url: "https://x", location: "", salary: "", bodyText: "" };
}

describe("selection: source priority", () => {
  test("curated sources rank 0, boards by table, unknown falls back", () => {
    assert.equal(sourcePriorityOf("greenhouse", SELECTION), 0);
    assert.equal(sourcePriorityOf("remotive", SELECTION), 1);
    assert.equal(sourcePriorityOf("remoteok", SELECTION), 2);
    assert.equal(sourcePriorityOf("brand-new-board", SELECTION), 3); // unknownSourcePriority
  });
});

describe("selection: interleaveByCompany", () => {
  test("a 6-posting Riot flood cannot crowd out other companies (the hyperfocus regression)", () => {
    const riot = Array.from({ length: 6 }, (_, i) => mkPosting("greenhouse", "Riot Games", `Job ${i}`));
    const discord = [mkPosting("greenhouse", "Discord", "A"), mkPosting("greenhouse", "Discord", "B")];
    const board = [mkPosting("hn", "Some Startup", "C")];

    const out = interleaveByCompany([...riot, ...discord, ...board], SELECTION);

    const riotCount = out.filter(p => p.company === "Riot Games").length;
    assert.equal(riotCount, 3); // perCompanyMax, not 6
    // Round-robin: a Riot posting, a Discord posting, a Riot posting, ... —
    // no company appears twice in a row until others run out.
    const firstThree = out.slice(0, 3).map(p => p.company);
    assert.notEqual(new Set(firstThree).size, 1);
  });

  test("lower-priority tier candidates all come after higher-priority ones", () => {
    const ats = [mkPosting("greenhouse", "A", "1")];
    const board = [mkPosting("hn", "B", "2")];
    const out = interleaveByCompany([...board, ...ats], SELECTION);
    assert.equal(out[0].source, "greenhouse"); // tier 0 before tier 1 despite input order
    assert.equal(out[1].source, "hn");
  });

  test("empty input produces empty output (no Math.max(...[]) blowup)", () => {
    assert.deepEqual(interleaveByCompany([], SELECTION), []);
  });
});

describe("selection: buildCandidates", () => {
  test("pending goes first, then interleaved new candidates, capped at limit", () => {
    const pending = [mkPosting("hn", "Old", "pending")];
    const fresh = Array.from({ length: 15 }, (_, i) => mkPosting("greenhouse", `Co${i}`, "x"));
    const out = buildCandidates(pending, fresh, SELECTION);
    assert.equal(out.length, 10); // limit
    assert.equal(out[0].id, "hn-Old-pending");
  });

  test("empty fresh pool + no pending yields empty (the nothing-to-rank case)", () => {
    assert.deepEqual(buildCandidates([], [], SELECTION), []);
  });
});

describe("selection: reservedSlots", () => {
  // 8 curated postings (tier 0) that would normally fill the whole limit.
  const curated = Array.from({ length: 8 }, (_, i) => mkPosting("greenhouse", `Co${i % 4}`, `J${i}`));
  const boards = [mkPosting("remotive", "B1", "x"), mkPosting("hn", "B2", "y")];

  test("reserved slots guarantee board candidates survive a curated flood", () => {
    const sel = { ...SELECTION, limit: 6, reservedSlots: 2 };
    const out = buildCandidates([], [...curated, ...boards], sel);

    assert.equal(out.length, 6);
    const lastTwo = out.slice(-2).map(p => p.source);
    // The reserved tail is where the board postings land.
    assert.ok(lastTwo.includes("remotive") && lastTwo.includes("hn"), `expected board sources in the tail, got ${lastTwo}`);
  });

  test("0 (the default) is a plain cap — no reserved tail", () => {
    const sel = { ...SELECTION, limit: 6 };
    const out = buildCandidates([], [...curated, ...boards], sel);
    assert.equal(out.filter(p => p.source === "greenhouse").length, 6);
    assert.deepEqual(out.slice(-2).map(p => p.source), ["greenhouse", "greenhouse"]);
  });

  test("backfills from remaining candidates when the reserved pool is too small", () => {
    const sel = { ...SELECTION, limit: 6, reservedSlots: 4 };
    const out = buildCandidates([], [...curated, ...boards], sel); // only 2 board candidates exist
    assert.equal(out.length, 6); // never shrinks the run
    assert.equal(out.filter(p => p.source === "greenhouse").length, 4);
  });

  test("reserved >= limit clamps: every slot goes to the reserved pool first", () => {
    const sel = { ...SELECTION, limit: 3, reservedSlots: 5 };
    const out = buildCandidates([], [...curated, ...boards], sel);
    assert.equal(out.length, 3);
    assert.equal(out.filter(p => p.source !== "greenhouse").length, 2);
  });

  test("pending postings keep their head-of-queue position", () => {
    const sel = { ...SELECTION, limit: 4, reservedSlots: 2 };
    const pending = [mkPosting("hn", "Old", "pending")];
    const out = buildCandidates(pending, curated, sel);
    assert.equal(out[0].id, "hn-Old-pending");
  });
});
