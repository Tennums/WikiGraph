/**
 * Communities in a small graph, by the Louvain method.
 *
 * Runs on the induced subgraph a view returns -- a few thousand nodes, tens of
 * thousands of edges -- so it has to be cheap: no dependency, a few milliseconds.
 *
 * Label propagation was tried first and is useless here. A neighbourhood view is a
 * few hubs plus everything they touch, and under label propagation a hub's label
 * simply floods its neighbourhood: 1,453 of 1,500 nodes ended up in one community.
 * Modularity asks a different question -- are these nodes more connected to each
 * other than their degrees would predict by chance -- and that is exactly the question
 * that a hub cannot win by size alone.
 *
 * Deterministic on purpose: nodes are visited in a fixed order (highest weight
 * first, so hubs settle before the fringe), and a node moves only for a strictly
 * positive gain, ties going to the smaller community id. The same view always
 * partitions the same way, which on a disc meant to be learnable is not optional.
 */

/**
 * @param {number} n             node count; nodes are 0..n-1
 * @param {Array<[number, number]>} edges   undirected pairs of node positions
 * @param {ArrayLike<number>} weight        per-node importance, for the visit order
 * @param {{ resolution?: number, maxLevels?: number }} [opts]
 *   resolution above 1 favours more, smaller communities; below 1 fewer, larger.
 * @returns {Int32Array} a community id per node, dense 0..k-1, numbered by size
 */
export function louvain(n, edges, weight, { resolution = 1, maxLevels = 10 } = {}) {
  // Working graph: adjacency with weights, as arrays of Maps (small graphs; clarity
  // over the last microsecond).
  let adj = Array.from({ length: n }, () => new Map());
  for (const [a, b] of edges) {
    if (a === b) continue;
    adj[a].set(b, (adj[a].get(b) ?? 0) + 1);
    adj[b].set(a, (adj[b].get(a) ?? 0) + 1);
  }
  let selfLoop = new Float64Array(n);      // internal weight once nodes are aggregates
  let order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (weight[b] - weight[a]) || (a - b));
  // membership of the ORIGINAL nodes, refined level by level
  let membership = Int32Array.from({ length: n }, (_, i) => i);

  for (let level = 0; level < maxLevels; level++) {
    const size = adj.length;
    const k = new Float64Array(size);             // weighted degree
    let m2 = 0;                                   // 2m
    for (let u = 0; u < size; u++) {
      let s = selfLoop[u] * 2;
      for (const w of adj[u].values()) s += w;
      k[u] = s; m2 += s;
    }
    if (m2 === 0) break;

    const comm = Int32Array.from({ length: size }, (_, i) => i);
    const tot = Float64Array.from(k);             // Σ_tot per community

    // ---- local moving --------------------------------------------------------
    let moved = true, passes = 0;
    const gainTo = new Map();
    while (moved && passes++ < 50) {
      moved = false;
      for (const u of order) {
        const cu = comm[u];
        // weight from u into each neighbouring community
        gainTo.clear();
        for (const [v, w] of adj[u]) gainTo.set(comm[v], (gainTo.get(comm[v]) ?? 0) + w);
        const kIn = gainTo.get(cu) ?? 0;
        // remove u from its community for the comparison
        tot[cu] -= k[u];
        let best = cu;
        let bestGain = kIn - resolution * k[u] * tot[cu] / m2;
        for (const [c, w] of gainTo) {
          if (c === cu) continue;
          const g = w - resolution * k[u] * tot[c] / m2;
          if (g > bestGain + 1e-12 || (Math.abs(g - bestGain) <= 1e-12 && c < best)) {
            best = c; bestGain = g;
          }
        }
        tot[best] += k[u];
        if (best !== cu) { comm[u] = best; moved = true; }
      }
    }

    // ---- did anything change at this level? ---------------------------------
    const ids = new Map();
    for (let u = 0; u < size; u++) if (!ids.has(comm[u])) ids.set(comm[u], ids.size);
    if (ids.size === size) break;                 // no merges: converged

    // fold into the original nodes' membership
    for (let i = 0; i < n; i++) membership[i] = ids.get(comm[membership[i]]);

    // ---- aggregate -----------------------------------------------------------
    const next = Array.from({ length: ids.size }, () => new Map());
    const nextSelf = new Float64Array(ids.size);
    for (let u = 0; u < size; u++) {
      const cu = ids.get(comm[u]);
      nextSelf[cu] += selfLoop[u];
      for (const [v, w] of adj[u]) {
        const cv = ids.get(comm[v]);
        if (cu === cv) nextSelf[cu] += w / 2;      // each internal edge seen twice
        else next[cu].set(cv, (next[cu].get(cv) ?? 0) + w);
      }
    }
    // visit order for aggregates: by their total weight, which is what settles hubs first
    const aggW = new Float64Array(ids.size);
    for (let i = 0; i < n; i++) aggW[membership[i]] += weight[i];
    adj = next; selfLoop = nextSelf;
    order = Array.from({ length: ids.size }, (_, i) => i)
      .sort((a, b) => (aggW[b] - aggW[a]) || (a - b));
  }

  // Dense ids, numbered by community size descending so "cluster 0" is the biggest.
  const count = new Map();
  for (const c of membership) count.set(c, (count.get(c) ?? 0) + 1);
  const rank = new Map([...count.entries()].sort((a, b) => b[1] - a[1]).map(([c], i) => [c, i]));
  return Int32Array.from(membership, (c) => rank.get(c));
}

/** Sizes of the communities in a labelling, largest first: [label, size]. */
export function communitySizes(label) {
  const size = new Map();
  for (const l of label) size.set(l, (size.get(l) ?? 0) + 1);
  return [...size.entries()].sort((a, b) => b[1] - a[1]);
}
