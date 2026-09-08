// scorers/colibri-rank.mjs — the colibri LLM scorer as a pipeline stage.
//
// Wraps colibri.mjs's streaming rankPostings(): every ranked chunk is handed
// to ctx.onRanked the moment it resolves, so a run killed by the scheduled
// task's timeout loses at most the chunk in flight. Chunks that fail
// (offline, timeout, bad HTTP) are DEFERRED via ctx.defer — never
// heuristic-scored here, so a colibri outage delays a posting's appearance
// (it sits in state/pending-colibri.json for a real retry) instead of
// permanently burning it into the digest with a degraded score. A chunk that
// SUCCEEDS but yields no parseable rankings (malformed/garbage JSON) is
// DEFERRED TOO, same as an outage: the 2026-09-07 audit showed the old
// "fall through to the terminal heuristic" path never marked the posting
// seen (the terminal scorer publishes with empty sourcePostings) and never
// removed it from the pending queue — so parse-0 postings re-ranked every
// run (300-780s of colibri each) and accrued one duplicate heuristic digest
// entry per run (gh-krafton-8581524002 did it three runs straight). This
// mirrors the gemma fallback's parse-empty-defers rule in colibri.mjs.
//
// SCORER interface (see pipeline/registry.mjs):
//   score(postings, params, ctx) -> { rankings, deferred, missed, online }

import { rankPostings } from "../colibri.mjs";
import { attachPostings } from "../pipeline/render.mjs";

export function init(cfg) {
  return { config: cfg };
}

export async function score(postings, params, ctx) {
  if (!postings.length) return { rankings: [], deferred: [], missed: [], online: true };

  const map = new Map(postings.map(p => [p.id, p]));
  const rankings = [];
  const deferred = [];

  const { colibriOnline } = await rankPostings(params.config, postings, async (parsed, chunk, { colibriOk }) => {
    if (!colibriOk) {
      // Deferred, not heuristic-scored — doesn't touch the digest, so it
      // must not flip the "Ranked by colibri" banner for entries that DID
      // get scored by colibri in this same run (the orchestrator computes
      // that banner from the chain composition, not from per-chunk health).
      deferred.push(...chunk);
      ctx.defer(chunk);
      console.error(`[main] colibri offline — queued ${chunk.length} posting(s) for retry next run (pending: ${ctx.pendingSize()})`);
      return;
    }
    if (!parsed.length) {
      // HTTP success, zero parseable rankings — malformed response, not an
      // outage (so the chain banner stays honest), but deferred all the same
      // (see header): a real retry beats a heuristic score that leaves the
      // posting unseen and re-ranked forever.
      deferred.push(...chunk);
      ctx.defer(chunk);
      console.error(`[colibri] chunk parsed 0 rankings (malformed response) — queued ${chunk.length} posting(s) for retry next run (pending: ${ctx.pendingSize()})`);
      return;
    }
    // chunkSize is always 1 (config.colibri.chunkSize), so the single
    // posting's real id is unambiguous — trust it over whatever colibri
    // echoed back in its JSON, which can mangle it (observed in
    // production: "gh-riotgames-7312899" came back as "gh-7312899",
    // which would otherwise silently orphan _posting via attachPostings's
    // placeholder fallback and lose the real posting's data).
    if (chunk.length === 1) {
      for (const r of parsed) r.id = chunk[0].id;
    }
    const attached = attachPostings(parsed, map);
    rankings.push(...attached);
    await ctx.onRanked(attached, chunk);
  });

  // Gaps the colibri scorer couldn't rank and isn't deferring (malformed
  // response, not an outage) go to the next scorer in the chain.
  const rankedIds = new Set(rankings.map(r => r.id));
  const deferredIds = new Set(deferred.map(p => p.id));
  const missed = postings.filter(p => !rankedIds.has(p.id) && !deferredIds.has(p.id));

  return { rankings, deferred, missed, online: colibriOnline };
}
