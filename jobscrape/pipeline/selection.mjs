// selection.mjs — which candidates make it into a run: source priority,
// round-robin across companies, and the overall cap. Parameters all come from
// config.selection (see config.mjs DEFAULTS).

// Curated ATS sources (companies we deliberately picked) rank ahead of
// generic job boards when the limit cap is applied. Unknown sources land at
// selection.unknownSourcePriority.
export function sourcePriorityOf(source, selection) {
  return selection.sourcePriorities[source] ?? selection.unknownSourcePriority;
}

// Round-robin across companies within each priority tier so no single
// company (e.g. Riot with 129+ eligible postings) can consume all limit
// slots before other curated companies or generic boards get a look.
// Before this fix the stable sort preserved fetch order within a tier,
// meaning the first-listed greenhouse company in config got every slot
// every day.
export function interleaveByCompany(postings, selection) {
  const tiers = {};
  for (const p of postings) {
    const pri = sourcePriorityOf(p.source, selection);
    if (!tiers[pri]) tiers[pri] = new Map();
    const key = `${p.source}:${p.company}`;
    if (!tiers[pri].has(key)) tiers[pri].set(key, []);
    tiers[pri].get(key).push(p);
  }
  const result = [];
  for (const pri of Object.keys(tiers).sort((a, b) => a - b)) {
    const queues = [...tiers[pri].values()];
    const maxLen = Math.min(
      Math.max(...queues.map(q => q.length)),
      selection.perCompanyMax,
    );
    for (let i = 0; i < maxLen; i++) {
      for (const q of queues) {
        if (i < q.length) result.push(q[i]);
      }
    }
  }
  return result;
}

// Pending postings (carried over from a prior colibri outage) go first —
// they're the oldest work in the queue and get first claim on this run's
// budget — then the interleaved new candidates, capped at selection.limit.
//
// With selection.reservedSlots > 0, the last N slots are held for candidates
// from sources whose priority >= selection.reservedSourcePriority (the
// generic boards), so a flood of curated-ATS postings can't squeeze every
// board posting out of a run. Slots the reserved pool can't fill are
// backfilled from the remaining interleaved candidates, so reserving never
// shrinks a run. reservedSlots: 0 (the default) reproduces the plain cap.
export function buildCandidates(pendingPostings, freshMatched, selection) {
  const limit = selection.limit;
  const reserved = Math.min(selection.reservedSlots || 0, limit);
  const sorted = interleaveByCompany(freshMatched, selection);

  if (!reserved) return [...pendingPostings, ...sorted].slice(0, limit);

  const head = [...pendingPostings, ...sorted].slice(0, limit - reserved);
  const chosen = new Set(head.map(p => `${p.source}:${p.id}`));
  const reservedPick = sorted
    .filter(p => !chosen.has(`${p.source}:${p.id}`) && sourcePriorityOf(p.source, selection) >= selection.reservedSourcePriority)
    .slice(0, reserved);
  const reservedIds = new Set(reservedPick.map(p => `${p.source}:${p.id}`));
  const rest = sorted.filter(p => !chosen.has(`${p.source}:${p.id}`) && !reservedIds.has(`${p.source}:${p.id}`));
  return [...head, ...reservedPick, ...rest].slice(0, limit);
}
