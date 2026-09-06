// parity.test.mjs — VCR-replay regression net for the refactor.
//
// Spawns scrape.mjs against the frozen cassette + frozen state snapshot and
// asserts the rendered digest is BYTE-identical to golden-digest.md, which
// was captured from the pre-refactor pipeline. Any refactor commit that
// changes postings selected, scores, ordering, labels, or rendering fails
// here — deliberately including "harmless" whitespace changes, since the
// digest is user-visible output and the KV-cache-sensitive prompt bytes
// deserve the same guard (see test/prompt.test.mjs once prompts are
// generated).
//
// Re-record the golden ONLY when an output change is intended:
//   1. JOBSCRAPE_VCR=record JOBSCRAPE_VCR_CASSETTE=test/fixtures/parity/cassette.json \
//      JOBSCRAPE_VCR_DATE=2026-09-06T07:00:00Z JOBSCRAPE_STATE_DIR=test/fixtures/parity/state \
//      JOBSCRAPE_CONFIG_DIR=$PWD/test/fixtures/parity \
//      node --import ./test/vcr.mjs scrape.mjs --once --dry-run --no-colibri --limit 40 \
//      > test/fixtures/parity/golden-digest.md
//   2. Reset state/seen.json to the committed snapshot, re-record, and review
//      the golden diff in the commit like any behavior change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures", "parity");
const JOBSCRAPE_ROOT = resolve(__dirname, "..");

test("digest output is byte-identical to the recorded golden (VCR replay)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jobscrape-parity-state-"));
  try {
    // Frozen seen/pending feed the dedupe stage; the run's last-run-*.json
    // snapshots land in the tmp copy, keeping the committed fixture pristine.
    for (const f of ["seen.json", "pending-colibri.json"]) {
      copyFileSync(join(FIXTURES, "state", f), join(stateDir, f));
    }

    const env = { ...process.env };
    delete env.JOBSCRAPE_PROFILE; // the fixture's own production.json applies
    env.JOBSCRAPE_VCR = "replay";
    env.JOBSCRAPE_VCR_CASSETTE = join(FIXTURES, "cassette.json");
    env.JOBSCRAPE_VCR_DATE = "2026-09-06T07:00:00Z";
    env.JOBSCRAPE_STATE_DIR = stateDir;
    env.JOBSCRAPE_CONFIG_DIR = FIXTURES;

    const r = spawnSync(process.execPath, [
      // --import demands a URL on Windows (bare C:\ paths are rejected by the
      // ESM loader); the main entry stays relative to cwd.
      "--import", pathToFileURL(resolve(__dirname, "vcr.mjs")).href,
      "scrape.mjs",
      "--once", "--dry-run", "--no-colibri", "--limit", "40",
    ], { cwd: JOBSCRAPE_ROOT, encoding: "buffer", timeout: 120000, env });

    assert.equal(r.status, 0, `replay run failed:\n${r.stderr?.toString()}\n${r.stdout?.toString()}`);
    assert.equal(
      r.stderr?.toString().includes("replay miss"), false,
      "replayed run hit a cassette miss — a fetch URL/flow changed",
    );

    const golden = readFileSync(join(FIXTURES, "golden-digest.md"));
    assert.ok(
      Buffer.compare(r.stdout, golden) === 0,
      `digest differs from golden (first diff:\n${firstDiff(golden, r.stdout)}\n)`,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function firstDiff(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      const start = Math.max(0, i - 40);
      return `byte ${i}: golden ...${JSON.stringify(a.subarray(start, i + 40).toString())} vs actual ...${JSON.stringify(b.subarray(start, i + 40).toString())}`;
    }
  }
  return `length ${a.length} vs ${b.length}`;
}
