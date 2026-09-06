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
export function buildCandidates(pendingPostings, freshMatched, selection) {
  const sorted = interleaveByCompany(freshMatched, selection);
  return [...pendingPostings, ...sorted].slice(0, selection.limit);
}
