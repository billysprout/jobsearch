// vcr.mjs — record/replay shim for globalThis.fetch, plus optional Date
// freezing. Lets the parity test re-run scrape.mjs against canned HTTP
// responses and compare the rendered digest byte-for-byte against a golden
// captured before a refactor — so behavior changes announce themselves
// instead of hiding inside "looks fine" manual testing.
//
// Usage (env-driven, meant for `node --import ./test/vcr.mjs scrape.mjs ...`):
//   JOBSCRAPE_VCR=record                — real fetches; responses appended to
//   JOBSCRAPE_VCR_CASSETTE=<file>         the cassette file at process exit
//   JOBSCRAPE_VCR=replay                — fetch served from the cassette;
//                                         a cache miss THROWS (loud, not a
//                                         silent live-fetch fallback — a
//                                         "parity" run that hits the network
//                                         proves nothing)
//   JOBSCRAPE_VCR_DATE=<iso>            — pin globalThis.Date (digest
//                                         filename/header depend on today)
//
// Cassettes are plain JSON arrays of {url, method, status, contentType, body}
// in first-request order. Bodies are stored decoded (post gzip/brotli) and
// replayed as text — res.json()/res.text() don't care, and content-encoding
// is deliberately not stored so Response doesn't try to re-decode.
//
// Determinism note: the pipeline is otherwise deterministic given identical
// fetch responses (sequential awaits, stable sorts, insertion-order maps), so
// pinned fetches + pinned Date = byte-stable stdout.

import { readFileSync, writeFileSync } from "node:fs";

const MODE = process.env.JOBSCRAPE_VCR;
const CASSETTE = process.env.JOBSCRAPE_VCR_CASSETTE;

if (MODE) {
  installVcr({ mode: MODE, cassette: CASSETTE });
}

export function installVcr({ mode, cassette }) {
  if (!cassette) throw new Error("JOBSCRAPE_VCR_CASSETTE is required with JOBSCRAPE_VCR");
  if (!["record", "replay"].includes(mode)) throw new Error(`bad JOBSCRAPE_VCR mode: ${mode}`);

  if (process.env.JOBSCRAPE_VCR_DATE) freezeDate(process.env.JOBSCRAPE_VCR_DATE);

  const realFetch = globalThis.fetch;
  const key = (method, url) => `${method} ${url}`;

  if (mode === "record") {
    const entries = [];
    globalThis.fetch = async (url, opts = {}) => {
      const res = await realFetch(url, opts);
      // Store the decoded body via a clone so the caller's own read is
      // unaffected; only same-origin GETs happen in this pipeline.
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      const body = await res.clone().text();
      entries.push({ url: String(url), method: opts.method || "GET", status: res.status, contentType, body });
      return res;
    };
    process.on("exit", () => {
      writeFileSync(cassette, JSON.stringify(entries, null, 1));
      console.error(`[vcr] recorded ${entries.length} response(s) -> ${cassette}`);
    });
    return;
  }

  // replay
  const queues = new Map();
  for (const entry of JSON.parse(readFileSync(cassette, "utf8"))) {
    const k = key(entry.method, entry.url);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(entry);
  }
  let served = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const k = key(opts.method || "GET", String(url));
    const queue = queues.get(k);
    if (!queue || !queue.length) {
      throw new Error(`[vcr] replay miss: ${k} — re-record the cassette (JOBSCRAPE_VCR=record)`);
    }
    const entry = queue.shift();
    served++;
    return new Response(entry.body, {
      status: entry.status,
      headers: { "content-type": entry.contentType },
    });
  };
  process.on("exit", () => {
    const missed = [...queues.values()].filter(q => q.length).reduce((n, q) => n + q.length, 0);
    console.error(`[vcr] replayed ${served} response(s), ${missed} cassette entry(ies) unused`);
  });
}

// Pin globalThis.Date so `new Date()` / Date.now() return a fixed instant
// (arguments still work: new Date(iso), Date.parse). Class extends keeps
// instanceof Date and the statics intact.
export function freezeDate(iso) {
  const RealDate = Date;
  const fixedMs = new RealDate(iso).getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMs);
      else super(...args);
    }
    static now() {
      return fixedMs;
    }
  }
  globalThis.Date = FrozenDate;
}
