// filters/recency.mjs — drop postings older than maxAgeDays. First-party
// filter stage, OFF by default (not in DEFAULTS.filters): most enabled
// sources expose usable dates, but turning this on changes what a run
// selects, so it's opt-in per profile.
//
// Config (filterConfig.recency):
//   maxAgeDays       number > 0 (default 30) — postings with postedAt older
//                    than this are dropped
//   keepUnknownDate  boolean (default true) — postings whose postedAt is
//                    missing or unparseable are KEPT by default; a source
//                    that doesn't expose dates shouldn't silently lose all
//                    its postings just because it can't prove freshness
//
// FILTER interface (see pipeline/registry.mjs):
//   init(cfg)                  -> params (throws ConfigError on a bad slice)
//   apply(postings, params)    -> { kept, dropped, byReason }
//
// Note: unlike the other stages this filter is inherently wall-clock
// dependent (the cutoff moves with Date.now()) — "deterministic" here means
// same-instant-same-input, not replayable across days.

import { ConfigError } from "../config.mjs";

export function init(cfg) {
  const rc = cfg.filterConfig?.recency || {};
  const maxAgeDays = rc.maxAgeDays ?? 30;
  const keepUnknownDate = rc.keepUnknownDate ?? true;

  if (typeof maxAgeDays !== "number" || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new ConfigError(`filterConfig.recency.maxAgeDays must be a number > 0 (got ${JSON.stringify(rc.maxAgeDays)})`);
  }
  if (typeof keepUnknownDate !== "boolean") {
    throw new ConfigError(`filterConfig.recency.keepUnknownDate must be true or false (got ${JSON.stringify(rc.keepUnknownDate)})`);
  }
  return { maxAgeDays, keepUnknownDate };
}

export function apply(postings, params) {
  const cutoff = Date.now() - params.maxAgeDays * 24 * 60 * 60 * 1000;
  const kept = [];
  let tooOld = 0;
  let unknownDate = 0;

  for (const p of postings) {
    const t = p.postedAt ? Date.parse(p.postedAt) : NaN;
    if (Number.isNaN(t)) {
      if (params.keepUnknownDate) kept.push(p);
      else unknownDate++;
      continue;
    }
    if (t >= cutoff) kept.push(p);
    else tooOld++;
  }

  console.error(`[filter:recency] ${kept.length} kept, ${tooOld} older than ${params.maxAgeDays}d, ${unknownDate} without a parseable date (${params.keepUnknownDate ? "kept" : "dropped"})`);
  return {
    kept,
    dropped: tooOld + unknownDate,
    byReason: { "too-old": tooOld, "unknown-date": unknownDate },
  };
}
