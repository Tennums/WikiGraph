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

import { openSync, readSync, statSync, closeSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MAGIC = 0x57474b31; // "WGK1"
const HEADER = 32; // 4 x int64

/**
 * One direction of the graph: a CSR file opened for positioned reads.
 *
 * Only the offset array is resident (8 bytes per article, 56 MB at enwiki scale). The
 * neighbour lists -- several GB for enwiki -- stay on disk and come in through the OS
 * page cache one slice at a time, which is what a neighbourhood query needs anyway.
 */
class Csr {
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, "r");
    const head = Buffer.allocUnsafe(HEADER);
    readSync(this.fd, head, 0, HEADER, 0);
    if (Number(head.readBigInt64LE(0)) !== MAGIC) {
      throw new Error(`${path} is not a wikigraph CSR (bad magic)`);
    }
    this.n = Number(head.readBigInt64LE(16));
    this.m = Number(head.readBigInt64LE(24));

    const offBytes = 8 * (this.n + 1);
    const expect = HEADER + offBytes + 4 * this.m;
    const actual = statSync(path).size;
    if (actual !== expect) {
      throw new Error(`${path} is truncated: ${actual} bytes, expected ${expect}`);
    }
    const off = Buffer.allocUnsafe(offBytes);
    readSync(this.fd, off, 0, offBytes, HEADER);
    this.offsets = new BigInt64Array(off.buffer, off.byteOffset, this.n + 1);
    this.base = HEADER + offBytes;
  }

  close() { closeSync(this.fd); }

  degree(idx) {
    return Number(this.offsets[idx + 1] - this.offsets[idx]);
  }

  /** Neighbours of `idx`, as stored: sorted and unique. */
  neighbours(idx) {
    if (idx < 0 || idx >= this.n) return new Int32Array(0);
    const a = this.offsets[idx], b = this.offsets[idx + 1];
    const count = Number(b - a);
    if (count === 0) return new Int32Array(0);
    const buf = Buffer.allocUnsafe(count * 4);
    readSync(this.fd, buf, 0, count * 4, this.base + Number(a) * 4);
    return new Int32Array(buf.buffer, buf.byteOffset, count);
  }

  /** Every node's degree as one typed array, from the offsets alone. */
  degrees() {
    const d = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) d[i] = Number(this.offsets[i + 1] - this.offsets[i]);
    return d;
  }
}

/** Intersection of two sorted, unique Int32Arrays, by merge. */
function intersectSorted(a, b) {
  const out = new Int32Array(Math.min(a.length, b.length));
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) i++;
    else if (a[i] > b[j]) j++;
    else { out[k++] = a[i]; i++; j++; }
  }
  return out.subarray(0, k);
}

/** Node kinds, as the ingest writes them into <wiki>.kind. */
export const KIND = { article: 0, list: 1, date: 2, dab: 3, infra: 4 };
export const KIND_NAMES = ["article", "list", "date", "dab", "infra"];

export class WikiGraph {
  /** @param {string} csrPath @param {string} rcsrPath @param {string} dbPath
   *  @param {string} kindPath @param {string} [searchPath] */
  constructor(csrPath, rcsrPath, dbPath, kindPath, searchPath) {
    this.out = new Csr(csrPath);   // who this article links to
    this.in = new Csr(rcsrPath);   // who links to this article
    if (this.in.n !== this.out.n || this.in.m !== this.out.m) {
      throw new Error(`${rcsrPath} does not match ${csrPath} -- rebuild with --reverse-only`);
    }
    this.n = this.out.n;
    this.m = this.out.m;

    // In-degree is the importance signal everywhere below: what the disc rings by,
    // what "best connected" means, how a search hit or a BFS frontier is ranked.
    // Out-degree measures how much an article lists, and lists win it; in-degree
    // measures how much the rest of the wiki refers to it.
    this.indeg = this.in.degrees();
    this._topOrder = null;

    // One byte per article: list, date page, disambiguation, template-linked
    // infrastructure, or a plain article. Selections skip whatever kinds the caller
    // asks to hide; the ingest only labels, so what counts as noise stays a view
    // setting rather than a build decision.
    const kb = Buffer.allocUnsafe(HEADER);
    const kfd = openSync(kindPath, "r");
    readSync(kfd, kb, 0, HEADER, 0);
    if (Number(kb.readBigInt64LE(0)) !== MAGIC || Number(kb.readBigInt64LE(16)) !== this.n) {
      closeSync(kfd);
      throw new Error(`${kindPath} does not match ${csrPath} -- rebuild with --classify-only`);
    }
    const kbuf = Buffer.allocUnsafe(this.n);
    readSync(kfd, kbuf, 0, this.n, HEADER);
    closeSync(kfd);
    this.kind = new Uint8Array(kbuf.buffer, kbuf.byteOffset, this.n);
    this.kindCounts = KIND_NAMES.map((_, k) => 0);
    for (let i = 0; i < this.n; i++) this.kindCounts[this.kind[i]]++;

    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.meta = Object.fromEntries(
      this.db.prepare("SELECT k, v FROM meta").all().map((r) => [r.k, r.v]),
    );

    // Optional: the FTS5 title index. Without it search falls back to a case-sensitive
    // prefix LIKE, which is what it was, so an older build keeps working -- just worse.
    this.fts = null;
    if (searchPath && existsSync(searchPath)) {
      this.fts = new DatabaseSync(searchPath, { readOnly: true });
    }
  }

  close() {
    this.db.close();
    if (this.fts) this.fts.close();
    this.out.close();
    this.in.close();
  }

  /**
   * Build the "is this article allowed" test for a set of hidden kind names. Kept as a
   * closure over a small typed array so the hot loops below pay one index and one
   * compare per candidate, not a Set lookup on a string.
   */
  allow(hide = []) {
    const mask = new Uint8Array(KIND_NAMES.length);
    for (const name of hide) if (KIND[name] !== undefined) mask[KIND[name]] = 1;
    const kind = this.kind;
    return (idx) => mask[kind[idx]] === 0;
  }

  /** Out-neighbours; kept under the old name because toVaultData draws edges from it. */
  neighbours(idx) { return this.out.neighbours(idx); }

  /**
   * Articles that link to `idx` AND that `idx` links to.
   *
   * A one-way link is a mention -- an infobox field, a passing reference. A link in
   * both directions means the two articles are about each other. Both neighbour lists
   * are sorted and unique, so this is one linear merge.
   */
  mutual(idx) {
    return intersectSorted(this.out.neighbours(idx), this.in.neighbours(idx));
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

  titleOf(idx) {
    const r = this.db.prepare("SELECT title FROM node WHERE idx = ?").get(idx);
    return r ? String(r.title) : String(idx);
  }

  /**
   * Title search, ranked by in-degree.
   *
   * With the FTS5 index: every word the user typed becomes a prefix term, so "alb ein"
   * finds Albert Einstein and "einstein" finds it too -- case-insensitive, diacritics
   * folded. Without it: the old prefix LIKE, fetched wide and re-ranked here.
   */
  search(q, limit = 20, hide = []) {
    const ok = this.allow(hide);
    const text = String(q).trim();
    if (!text) return [];

    let rows;
    if (this.fts) {
      // Each word a prefix term; FTS5 syntax characters are stripped, since a stray
      // quote or asterisk from the user is a typo, not an operator.
      const terms = text.split(/\s+/).map((w) => w.replace(/["*():^\-]/g, "")).filter(Boolean);
      if (!terms.length) return [];
      const match = terms.map((w) => `"${w}"*`).join(" ");
      // ORDER BY over an unindexed column materialises every match, so a one-letter
      // prefix is the slow case; the UI asks for two characters or more.
      rows = this.fts
        .prepare("SELECT idx, title FROM titles WHERE titles MATCH ? ORDER BY indeg DESC LIMIT ?")
        .all(match, limit * 5)
        .map((r) => ({ idx: Number(r.idx), title: String(r.title).replace(/ /g, "_") }));
    } else {
      rows = this.db
        .prepare("SELECT idx, title FROM node WHERE title LIKE ? LIMIT ?")
        .all(text.replace(/ /g, "_") + "%", Math.max(200, limit * 10))
        .map((r) => ({ idx: Number(r.idx), title: String(r.title) }));
    }
    return rows
      .map((h) => ({ ...h, deg: this.indeg[h.idx] }))
      .filter((h) => ok(h.idx))
      .sort((a, b) => b.deg - a.deg)
      .slice(0, limit);
  }

  /** Category names by prefix, biggest first -- for the category view's typeahead. */
  searchCategories(q, limit = 20) {
    const t = String(q).trim().replace(/ /g, "_");
    if (!t) return [];
    return this.db
      .prepare(`SELECT c.title AS title, count(nc.idx) AS n
                FROM category c LEFT JOIN node_cat nc ON nc.cat = c.pid
                WHERE c.title LIKE ? AND c.hidden = 0
                GROUP BY c.pid ORDER BY n DESC LIMIT ?`)
      .all(t + "%", limit)
      .map((r) => ({ title: String(r.title), deg: Number(r.n) }));
  }

  // ------------------------------------------------------------------- selections
  //
  // Each of these answers "which few thousand articles" for one kind of question.

  /**
   * Breadth-first from one article, taking the best-connected candidates first.
   *
   * Plain BFS from a well-linked article overshoots the budget on the first hop and
   * fills the disc with whatever happened to be scanned first. Ordering each frontier
   * by in-degree instead means the budget is spent on the articles the rest of the
   * wiki cares about, and the result is stable across runs.
   *
   * `direction` is which links to follow: "out" (what this article cites), "in" (what
   * cites it -- "what links here"), "both", or "mutual" (only links that go both ways).
   */
  neighborhood(seed, { hops = 2, limit = 3000, direction = "both", hide = [] } = {}) {
    const ok = this.allow(hide);
    const expand = (u) => {
      if (direction === "out") return [this.out.neighbours(u)];
      if (direction === "in") return [this.in.neighbours(u)];
      if (direction === "mutual") return [this.mutual(u)];
      return [this.out.neighbours(u), this.in.neighbours(u)];
    };
    const seen = new Map([[seed, 0]]);
    let frontier = [seed];
    for (let h = 1; h <= hops && seen.size < limit; h++) {
      const next = new Map();
      for (const u of frontier) {
        for (const list of expand(u)) {
          for (const v of list) {
            if (!seen.has(v) && !next.has(v) && ok(v)) next.set(v, this.indeg[v]);
          }
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

  /**
   * Shortest link path from `a` to `b`: the "six degrees of Wikipedia" question.
   *
   * Bidirectional: forward from `a` along out-links, backward from `b` along in-links,
   * always growing the smaller side. Wikipedia's link graph has a diameter of a few
   * hops but hubs with a million in-links, so a one-sided search from a popular
   * target would read most of the graph; meeting in the middle keeps both frontiers
   * to a few thousand articles. Returns the path as node ids, or null.
   */
  path(a, b, { maxDepth = 8, maxVisited = 4_000_000, hide = [], mutual = false } = {}) {
    if (a === b) return [a];
    // The endpoints are the user's choice and always allowed; a hidden kind is only
    // refused as a stepping stone. Without this every path went through a list page.
    const ok = this.allow(hide);
    // A mutual-only path is a chain of articles that each refer back to the previous
    // one: rarer, longer, and much more meaningful than a chain of mentions.
    const step = mutual ? (u) => this.mutual(u) : null;
    const fwd = new Map([[a, -1]]);   // node -> parent towards a
    const bwd = new Map([[b, -1]]);   // node -> parent towards b
    let fFront = [a], bFront = [b];

    const meet = (x) => {
      const left = [];
      for (let u = x; u !== -1; u = fwd.get(u)) left.push(u);
      left.reverse();
      const right = [];
      for (let u = bwd.get(x); u !== -1 && u !== undefined; u = bwd.get(u)) right.push(u);
      return left.concat(right);
    };

    for (let d = 0; d < maxDepth; d++) {
      if (!fFront.length || !bFront.length) return null;
      if (fwd.size + bwd.size > maxVisited) return null;
      const forward = fFront.length <= bFront.length;
      const [front, own, other, csr] = forward
        ? [fFront, fwd, bwd, this.out] : [bFront, bwd, fwd, this.in];
      const next = [];
      for (const u of front) {
        for (const v of step ? step(u) : csr.neighbours(u)) {
          if (own.has(v)) continue;
          if (!ok(v) && v !== a && v !== b) continue;
          own.set(v, u);
          if (other.has(v)) return meet(v);
          next.push(v);
        }
      }
      if (forward) fFront = next; else bFront = next;
    }
    return null;
  }

  /** Every article filed under `catPid`, walking `depth` levels of subcategories. */
  categorySubtree(catPid, { depth = 3, limit = 3000, hide = [] } = {}) {
    const ok = this.allow(hide);
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
        if (branch.has(idx) || !ok(idx)) continue;
        branch.set(idx, branchOf.get(c));
        ids.push(idx);
        if (ids.length >= limit) break outer;
      }
    }
    return { ids, branch, root: catPid };
  }

  /**
   * The `limit` most linked-to articles: the wiki's own centre of gravity.
   *
   * By in-degree, computed once and cached. The trick is a numeric typed-array sort:
   * packing (indeg, idx) into one float -- indeg * 2^24 + idx, exact below 2^53 --
   * lets Float64Array.sort run without a comparator, which is what makes ordering
   * enwiki's 7M articles a sub-second startup cost rather than a 30-second one.
   */
  top(limit = 3000, hide = []) {
    const ok = this.allow(hide);
    if (!this._topOrder) {
      const key = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) key[i] = this.indeg[i] * 16777216 + i;
      key.sort();
      this._topOrder = key;
    }
    const out = [];
    for (let k = this.n - 1; k >= 0 && out.length < limit; k--) {
      const idx = this._topOrder[k] % 16777216;
      if (ok(idx)) out.push(idx);
    }
    return out;
  }

  // ------------------------------------------------------------------ assembly
  //
  // Everything above chooses ids. This turns a set of ids into the exact object the
  // vault-graph page expects to find in `window.VAULT_DATA`.

  /**
   * @param {number[]} ids
   * @param {{ title: string, wedgeOf?: Map<number,number>, wedges?: number,
   *           depth?: Map<number,number>, typeOf?: (id: number) => string,
   *           mutual?: boolean }} opts
   */
  toVaultData(ids, opts) {
    const { title, wedgeOf, wedges = 12, depth, typeOf, mutual = false } = opts;
    const pos = new Map(ids.map((id, i) => [id, i]));
    const ph = ids.map(() => "?").join(",");

    const rows = new Map(
      this.db
        .prepare(`SELECT idx, title, len, touched, deg, topic FROM node WHERE idx IN (${ph})`)
        .all(...ids)
        .map((r) => [Number(r.idx), r]),
    );

    const label = (t) => String(t).replace(/_/g, " ");
    const hopLabel = (h) => (h === 0 ? "the seed" : h === 1 ? "1 hop away" : `${h} hops away`);

    // Wedges. The category view knows its own grouping and passes it in; every other
    // view uses the topic assigned at build time.
    //
    // Raw categories were tried here first and do not work: they are a fine-grained
    // overlapping mesh rather than a hierarchy, so taking the commonest ones across a
    // selection left two thirds of the articles in none of them. The build's walk down
    // from the wiki's own subject roots is what gives an article something folder-
    // shaped to belong to.
    // A caller-supplied grouping (the category view's subcategories) is pooled the same
    // way topics are: the biggest `wedges` keep their own slice, the rest share one.
    // Twenty-five wedges of which nine hold one article each is a legend, not a disc.
    const POOL = -1;
    let catName = new Map();
    if (wedgeOf) {
      const freq = new Map();
      for (const id of ids) {
        const w = wedgeOf.get(id);
        if (w !== undefined) freq.set(w, (freq.get(w) ?? 0) + 1);
      }
      const keep = new Set([...freq.entries()].sort((a, b) => b[1] - a[1])
        .slice(0, wedges).map(([w]) => w));
      const pooled = [...freq.keys()].filter((w) => !keep.has(w)).length;
      for (const [id, w] of wedgeOf) if (!keep.has(w)) wedgeOf.set(id, POOL);
      catName = this._catNames([...keep]);
      if (pooled) catName.set(POOL, `(${pooled} smaller subcategories)`);
    }

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
        // that a category view does not, so it rides along as the node's type. The
        // detail card prints it after the topic ("Science / 2 hops away").
        type: typeOf ? typeOf(id) : depth ? hopLabel(depth.get(id) ?? 0) : "article",
        // The kind rides along as a tag so the card shows why a list page is a list page.
        tags: this.kind[id] ? [KIND_NAMES[this.kind[id]]] : [],
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
    // With `mutual` an edge is drawn only if it exists in both directions. The first
    // pass collects every directed link inside the selection; the second keeps a pair
    // when its reverse was also seen. Keyed on the selection positions, which are
    // small, rather than on node ids.
    const edges = [];
    const seen = mutual ? new Set() : null;
    const n = ids.length;
    for (const id of ids) {
      const from = pos.get(id);
      for (const v of this.neighbours(id)) {
        const to = pos.get(v);
        if (to === undefined || to === from) continue;
        if (mutual) { seen.add(from * n + to); continue; }
        if (to < from) continue; // undirected, once
        edges.push({ s: from, t: to, w: 1 });
        nodes[from].deg++;
        nodes[to].deg++;
      }
    }
    if (mutual) {
      for (const key of seen) {
        const from = Math.floor(key / n), to = key % n;
        if (to < from || !seen.has(to * n + from)) continue;
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
