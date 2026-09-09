/**
 * The graph store: a CSR file on disk and a SQLite sidecar, turned into the bounded
 * subgraphs the disc can actually draw.
 *
 * The whole design follows from one number. vault-graph re-plans its entire layout on
 * every animated frame -- that is what makes the motion continuous rather than
 * interpolated -- and its own issue tracker records 10k nodes animating at 14 fps.
 * enwiki has ~7M articles. So the graph is never handed to the browser; it is queried,
 * and each query returns a few thousand nodes chosen for a reason.
 *
 * The CSR is read with positioned reads rather than loaded. enwiki's target array runs
 * to several GB, past what a single Node Buffer can hold, and the OS page cache already
 * does the caching a hand-rolled loader would. Only the offset array stays resident:
 * 8 bytes per article, 56 MB at enwiki scale.
 */

import { openSync, readSync, statSync, closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MAGIC = 0x57474b31; // "WGK1"
const HEADER = 32; // 4 x int64

export class WikiGraph {
  /** @param {string} csrPath @param {string} dbPath */
  constructor(csrPath, dbPath) {
    this.fd = openSync(csrPath, "r");

    const head = Buffer.allocUnsafe(HEADER);
    readSync(this.fd, head, 0, HEADER, 0);
    if (Number(head.readBigInt64LE(0)) !== MAGIC) {
      throw new Error(`${csrPath} is not a wikigraph CSR (bad magic)`);
    }
    this.n = Number(head.readBigInt64LE(16));
    this.m = Number(head.readBigInt64LE(24));

    const offBytes = 8 * (this.n + 1);
    const expect = HEADER + offBytes + 4 * this.m;
    const actual = statSync(csrPath).size;
    if (actual !== expect) {
      throw new Error(`${csrPath} is truncated: ${actual} bytes, expected ${expect}`);
    }

    // Resident. Everything else is paged in on demand.
    const off = Buffer.allocUnsafe(offBytes);
    readSync(this.fd, off, 0, offBytes, HEADER);
    this.offsets = new BigInt64Array(off.buffer, off.byteOffset, this.n + 1);
    this.targetBase = HEADER + offBytes;

    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.meta = Object.fromEntries(
      this.db.prepare("SELECT k, v FROM meta").all().map((r) => [r.k, r.v]),
    );
  }

  close() {
    this.db.close();
    closeSync(this.fd);
  }

  /** Out-neighbours of `idx`, as stored: sorted and unique. */
  neighbours(idx) {
    if (idx < 0 || idx >= this.n) return new Int32Array(0);
    const a = this.offsets[idx], b = this.offsets[idx + 1];
    const count = Number(b - a);
    if (count === 0) return new Int32Array(0);
    const buf = Buffer.allocUnsafe(count * 4);
    readSync(this.fd, buf, 0, count * 4, this.targetBase + Number(a) * 4);
    return new Int32Array(buf.buffer, buf.byteOffset, count);
  }

  degree(idx) {
    return Number(this.offsets[idx + 1] - this.offsets[idx]);
  }

  /** Resolve a human title ("Isaac Newton" or "Isaac_Newton") to a node index. */
  lookup(title) {
    const t = String(title).trim().replace(/ /g, "_");
    const row = this.db.prepare("SELECT idx FROM node WHERE title = ?").get(t)
      // Titles are case-sensitive after the first letter; try the usual capitalisation
      // before giving up, so "physics" finds "Physics".
      ?? this.db.prepare("SELECT idx FROM node WHERE title = ?")
             .get(t.charAt(0).toUpperCase() + t.slice(1));
    return row ? Number(row.idx) : -1;
  }

  search(q, limit = 20) {
    return this.db
      .prepare("SELECT idx, title, deg FROM node WHERE title LIKE ? ORDER BY deg DESC LIMIT ?")
      .all(String(q).trim().replace(/ /g, "_") + "%", limit)
      .map((r) => ({ idx: Number(r.idx), title: String(r.title), deg: Number(r.deg) }));
  }

  // ------------------------------------------------------------------- selections
  //
  // Each of these answers "which few thousand articles" for one kind of question.

  /**
   * Breadth-first from one article, taking the best-connected candidates first.
   *
   * Plain BFS from a well-linked article overshoots the budget on the first hop and
   * fills the disc with whatever happened to be scanned first. Ordering each frontier
   * by degree instead means the budget is spent on the articles that carry the
   * neighbourhood's structure, and the result is stable across runs.
   */
  neighborhood(seed, { hops = 2, limit = 3000 } = {}) {
    const seen = new Map([[seed, 0]]);
    let frontier = [seed];
    for (let h = 1; h <= hops && seen.size < limit; h++) {
      const next = new Map();
      for (const u of frontier) {
        for (const v of this.neighbours(u)) {
          if (!seen.has(v) && !next.has(v)) next.set(v, this.degree(v));
        }
      }
      const room = limit - seen.size;
      const ranked = [...next.entries()].sort((a, b) => b[1] - a[1]).slice(0, room);
      for (const [v] of ranked) seen.set(v, h);
      frontier = ranked.map(([v]) => v);
      if (!frontier.length) break;
    }
    return { ids: [...seen.keys()], depth: seen, seed };
  }

  /** Every article filed under `catPid`, walking `depth` levels of subcategories. */
  categorySubtree(catPid, { depth = 3, limit = 3000 } = {}) {
    const kids = this.db.prepare("SELECT child FROM cat_tree WHERE parent = ?");
    const members = this.db.prepare("SELECT idx FROM node_cat WHERE cat = ?");

    // Which direct child of the root each category descends from -- this becomes the
    // wedge, and it is why the walk tracks a branch rather than just a visited set.
    const branchOf = new Map([[catPid, catPid]]);
    const order = [catPid];
    let level = [catPid];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const c of level) {
        for (const r of kids.all(c)) {
          const child = Number(r.child);
          if (branchOf.has(child)) continue;
          branchOf.set(child, d === 0 ? child : branchOf.get(c));
          next.push(child);
          order.push(child);
        }
      }
      if (!next.length) break;
      level = next;
    }

    const ids = [];
    const branch = new Map();
    outer: for (const c of order) {
      for (const r of members.all(c)) {
        const idx = Number(r.idx);
        if (branch.has(idx)) continue;
        branch.set(idx, branchOf.get(c));
        ids.push(idx);
        if (ids.length >= limit) break outer;
      }
    }
    return { ids, branch, root: catPid };
  }

  /** The `limit` best-connected articles: a map of the wiki's own centre of gravity. */
  top(limit = 3000) {
    return this.db
      .prepare("SELECT idx FROM node ORDER BY deg DESC LIMIT ?")
      .all(limit)
      .map((r) => Number(r.idx));
  }

  // ------------------------------------------------------------------ assembly
  //
  // Everything above chooses ids. This turns a set of ids into the exact object the
  // vault-graph page expects to find in `window.VAULT_DATA`.

  /**
   * @param {number[]} ids
   * @param {{ title: string, wedgeOf?: Map<number,number>, wedges?: number,
   *           depth?: Map<number,number> }} opts
   */
  toVaultData(ids, opts) {
    const { title, wedgeOf, wedges = 12, depth } = opts;
    const pos = new Map(ids.map((id, i) => [id, i]));
    const ph = ids.map(() => "?").join(",");

    const rows = new Map(
      this.db
        .prepare(`SELECT idx, title, len, touched, deg, topic FROM node WHERE idx IN (${ph})`)
        .all(...ids)
        .map((r) => [Number(r.idx), r]),
    );

    const label = (t) => String(t).replace(/_/g, " ");

    // Wedges. The category view knows its own grouping and passes it in; every other
    // view uses the topic assigned at build time.
    //
    // Raw categories were tried here first and do not work: they are a fine-grained
    // overlapping mesh rather than a hierarchy, so taking the commonest ones across a
    // selection left two thirds of the articles in none of them. The build's walk down
    // from the wiki's own subject roots is what gives an article something folder-
    // shaped to belong to.
    let catName = new Map();
    if (wedgeOf) catName = this._catNames([...new Set(wedgeOf.values())]);

    // A wedge per article is only useful while there are few enough to read. Past that
    // the tail is pooled, so one enormous subject cannot crowd out the rest.
    let allow = null;
    if (!wedgeOf) {
      const freq = new Map();
      for (const id of ids) {
        const t = rows.get(id)?.topic;
        if (t) freq.set(t, (freq.get(t) ?? 0) + 1);
      }
      allow = new Set([...freq.entries()].sort((a, b) => b[1] - a[1])
        .slice(0, wedges).map(([t]) => t));
    }

    const folderFor = (id) => {
      if (wedgeOf) {
        const c = wedgeOf.get(id);
        return c === undefined ? "(uncategorised)" : label(catName.get(c) ?? "?");
      }
      const t = rows.get(id)?.topic;
      if (!t) return "(uncategorised)";
      return allow.has(t) ? label(t) : "(other topics)";
    };

    const nodes = ids.map((id) => {
      const r = rows.get(id);
      const t = r ? String(r.touched) : "";
      return {
        id: String(id),
        label: r ? label(r.title) : String(id),
        folder: folderFor(id),
        dirs: [],
        sub: "",
        // The hop a node was reached at is the one grouping a neighbourhood view has
        // that a category view does not, so it rides along as the node's type.
        type: depth ? `hop-${depth.get(id) ?? 0}` : "article",
        tags: [],
        // `page` carries no creation date -- only `page_touched`. The timeline is
        // therefore "last edited", and the UI says so rather than implying growth.
        created: t ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : "",
        touched: t ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : "",
        words: r ? Math.round(Number(r.len) / 6) : 0, // bytes -> rough word count
        deg: 0,
      };
    });

    // Edges are the selection's induced subgraph: a link is drawn only when both ends
    // made the cut. Degree is recomputed over what is actually shown, because the disc
    // rings notes by the degree it can see -- a global degree would push articles to
    // the centre for links to nodes that are not on screen.
    const edges = [];
    for (const id of ids) {
      const from = pos.get(id);
      for (const v of this.neighbours(id)) {
        const to = pos.get(v);
        if (to === undefined || to <= from) continue; // undirected, once
        edges.push({ s: from, t: to, w: 1 });
        nodes[from].deg++;
        nodes[to].deg++;
      }
    }

    return {
      vault: title,
      generated: new Date().toISOString().slice(0, 16).replace("T", " "),
      nodes,
      edges,
      stats: {
        files: nodes.length,
        nodes: nodes.length,
        edges: edges.length,
        unresolved: 0,
        orphans: nodes.filter((x) => x.deg === 0).length,
        dates: { frontmatter: 0, filename: 0, stamp: nodes.length, none: 0 },
        templatesExcluded: false,
        ghostsIncluded: false,
      },
      dev: false,
    };
  }

  _catNames(pids) {
    if (!pids.length) return new Map();
    const ph = pids.map(() => "?").join(",");
    return new Map(
      this.db
        .prepare(`SELECT pid, title FROM category WHERE pid IN (${ph})`)
        .all(...pids)
        .map((r) => [Number(r.pid), String(r.title)]),
    );
  }

  findCategory(title) {
    const t = String(title).trim().replace(/ /g, "_").replace(/^Category:/i, "");
    const row = this.db.prepare("SELECT pid FROM category WHERE title = ?").get(t)
      ?? this.db.prepare("SELECT pid FROM category WHERE title = ?")
             .get(t.charAt(0).toUpperCase() + t.slice(1));
    return row ? Number(row.pid) : -1;
  }
}
