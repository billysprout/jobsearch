// filters/blocklist.mjs — never show postings from a named company or whose
// title matches a pattern. First-party filter stage, OFF by default (not in
// DEFAULTS.filters): with an empty blocklist it's a no-op, and being in the
// chain only costs noise.
//
// Runs BEFORE dedupe like every filter (see pipeline/registry.mjs): a
// blocklisted posting is never marked seen, so un-blocking it later lets it
// surface on the next run instead of it having been silently burned years
// — runs — ago.
//
// Config (filterConfig.blocklist):
//   companies      string[] — matched case-insensitively against the whole
//                  company field
//   titlePatterns  string[] — regex sources (case-insensitive), tested
//                  against the title; non-compiling patterns throw
//                  ConfigError at init so a typo'd pattern is a startup
//                  error, not a silently-inert filter
//
// FILTER interface (see pipeline/registry.mjs):
//   init(cfg)                  -> params (throws ConfigError on a bad slice)
//   apply(postings, params)    -> { kept, dropped, byReason }

import { ConfigError } from "../config.mjs";

export function init(cfg) {
  const bc = cfg.filterConfig?.blocklist || {};

  const companyList = Array.isArray(bc.companies) ? bc.companies : [];
  if (!companyList.every(c => typeof c === "string" && c)) {
    throw new ConfigError("filterConfig.blocklist.companies must be an array of non-empty strings");
  }

  const patternList = Array.isArray(bc.titlePatterns) ? bc.titlePatterns : [];
  const titlePatterns = patternList.map(src => {
    try {
      return new RegExp(src, "i");
    } catch (e) {
      throw new ConfigError(`filterConfig.blocklist.titlePatterns: "${src}" is not a valid regex: ${e.message}`);
    }
  });

  return { companies: new Set(companyList.map(c => c.toLowerCase())), titlePatterns };
}

export function apply(postings, params) {
  const kept = [];
  let byCompany = 0;
  let byTitle = 0;

  for (const p of postings) {
    if (params.companies.has((p.company || "").toLowerCase())) {
      byCompany++;
      continue;
    }
    if (params.titlePatterns.some(re => re.test(p.title || ""))) {
      byTitle++;
      continue;
    }
    kept.push(p);
  }

  console.error(`[filter:blocklist] ${kept.length} kept, ${byCompany} blocked by company, ${byTitle} blocked by title`);
  return {
    kept,
    dropped: byCompany + byTitle,
    byReason: { "blocklisted-company": byCompany, "blocklisted-title": byTitle },
  };
}
