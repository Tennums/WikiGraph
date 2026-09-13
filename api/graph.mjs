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
import { louvain } from "./cluster.mjs";

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

/**
 * Categories that organise rather than describe: stub sorting, "X by country"
 * containers, template and list holders, project bookkeeping. Fine to walk through,
 * wrong to name a wedge after. Most are flagged hidden in `page_props` and caught by
 * the flag; the pattern is for the wikis and cases that are not.
 */
const ORGANISING_CAT = /(_stubs?|_templates|-related_lists|_by_[a-z_]+|_redirects)$|^(Wikipedia|WikiProject|Redirects|Stubs?|Commons_category|Articles_with|Articles_containing|Pages_with|Pages_using|All|CS1|Use_[a-z]+_dates|Webarchive|Short_description|Coordinates)_|_articles(_|$)/;

/** Node kinds, as the ingest writes them into <wiki>.kind. */
const label_ = (t) => String(t).replace(/_/g, " ");

export const KIND = { article: 0, list: 1, date: 2, dab: 3, infra: 4 };
export const KIND_NAMES = ["article", "list", "date", "dab", "infra"];

/**
 * The build before this one, for "what changed since": its in-link graph and its title
 * table, nothing more. Articles are matched by title -- each build numbers its own --
 * through the old database's title index, one lookup per article asked about, rather
 * than a seven-million-entry map held in memory for a question asked now and then.
 */
export class PreviousBuild {
  constructor(dir, wiki, name) {
    this.name = name;
    this.in = new Csr(`${dir}/${wiki}.rcsr`);
    this.db = new DatabaseSync(`${dir}/${wiki}.db`, { readOnly: true });
    this._idx = this.db.prepare("SELECT idx FROM node WHERE title = ?");
    this._cache = new Map();   // title -> old idx or -1, for the lens's many lookups
  }

  /** The article's index in the old build, or -1 if it was not there. */
  idxOf(title) {
    let i = this._cache.get(title);
    if (i === undefined) {
      const r = this._idx.get(title);
      i = r ? Number(r.idx) : -1;
      if (this._cache.size > 50000) this._cache.clear();
      this._cache.set(title, i);
    }
    return i;
  }

  /** Titles of the old in-neighbours of an old index. */
  inTitles(oldIdx) {
    const ids = this.in.neighbours(oldIdx);
    const out = [];
    for (let at = 0; at < ids.length; at += 5000) {
      const chunk = Array.from(ids.subarray(at, at + 5000));
      const ph = chunk.map(() => "?").join(",");
      for (const r of this.db.prepare(`SELECT title FROM node WHERE idx IN (${ph})`).all(...chunk)) out.push(String(r.title));
    }
    return out;
  }

  /** Did `from` link to `to` in the old build, given their old indices? */
  hadLink(from, to, inOfTo) {
    const arr = inOfTo ?? this.in.neighbours(to);
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < from) lo = mid + 1; else if (arr[mid] > from) hi = mid - 1; else return true; }
    return false;
  }
}

export class WikiGraph {
  /** @param {string} csrPath @param {string} rcsrPath @param {string} dbPath
   *  @param {string} kindPath @param {string} [searchPath] @param {string} [rankPath] */
  constructor(csrPath, rcsrPath, dbPath, kindPath, searchPath, rankPath) {
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
    this._maskCache = new Map();

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

    // Article length in bytes of wikitext, for the stub filter. Streamed out of the
    // database at startup rather than kept in a sidecar: 7M rows take about three
    // seconds on enwiki, once, and it spares the ingest yet another output.
    this.len = new Int32Array(this.n);
    for (const r of this.db.prepare("SELECT idx, len FROM node").iterate()) {
      this.len[r.idx] = r.len;
    }

    // Optional: PageRank, a float per article. In-degree counts links; PageRank weighs
    // each by where it comes from. Either can be the importance signal for a request
    // (`rankBy`); the default stays in-degree, which needs no extra file.
    this.rank = null;
    if (rankPath && existsSync(rankPath)) {
      const rb = Buffer.allocUnsafe(HEADER);
      const rfd = openSync(rankPath, "r");
      readSync(rfd, rb, 0, HEADER, 0);
      if (Number(rb.readBigInt64LE(0)) === MAGIC && Number(rb.readBigInt64LE(16)) === this.n) {
        const rbuf = Buffer.allocUnsafe(this.n * 4);
        readSync(rfd, rbuf, 0, this.n * 4, HEADER);
        this.rank = new Float32Array(rbuf.buffer, rbuf.byteOffset, this.n);
      }
      closeSync(rfd);
    }
    this._topOrders = new Map();

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
   * Build the "is this article allowed" test for a set of hidden kind names and a
   * minimum length. Kept as a closure over two typed arrays so the hot loops below
   * pay two indexes and two compares per candidate, not a Set lookup on a string.
   */
  allow(hide = [], minLen = 0, within = null) {
    const mask = new Uint8Array(KIND_NAMES.length);
    for (const name of hide) if (KIND[name] !== undefined) mask[KIND[name]] = 1;
    const kind = this.kind, len = this.len;
    const base = minLen > 0
      ? (idx) => mask[kind[idx]] === 0 && len[idx] >= minLen
      : (idx) => mask[kind[idx]] === 0;
    // `within` is a membership mask over all articles (see categoryMask); one more
    // byte lookup per candidate.
    return within ? (idx) => within[idx] === 1 && base(idx) : base;
  }

  /**
   * Every article filed under `catPid` or its subcategories, `depth` levels down, as
   * a one-byte-per-article mask -- the shape `allow()` already tests against, and
   * cheaper than a Set once a category runs to hundreds of thousands of members.
   *
   * Organising categories are walked through here without distinction: for a filter
   * "under Science" means everything under it, however it is filed.
   *
   * The last few masks are kept, since a typeahead or a redraw asks for the same
   * category again and a walk over a big category is the expensive part of a request.
   */
  categoryMask(catPid, depth = 3) {
    const key = `${catPid}:${depth}`;
    const hit = this._maskCache.get(key);
    if (hit) { this._maskCache.delete(key); this._maskCache.set(key, hit); return hit; }

    const kids = this.db.prepare("SELECT child FROM cat_tree WHERE parent = ?");
    const members = this.db.prepare("SELECT idx FROM node_cat WHERE cat = ?");
    const seen = new Set([catPid]);
    let level = [catPid];
    for (let d = 0; d < depth && level.length; d++) {
      const next = [];
      for (const c of level) {
        for (const r of kids.all(c)) {
          const child = Number(r.child);
          if (!seen.has(child)) { seen.add(child); next.push(child); }
        }
      }
      level = next;
    }
    const mask = new Uint8Array(this.n);
    let count = 0;
    for (const c of seen) {
      for (const r of members.all(c)) {
        const i = Number(r.idx);
        if (mask[i] === 0) { mask[i] = 1; count++; }
      }
    }
    mask.count = count;
    mask.categories = seen.size;
    this._maskCache.set(key, mask);
    if (this._maskCache.size > 8) this._maskCache.delete(this._maskCache.keys().next().value);
    return mask;
  }

  /** The importance array a request ranks by: in-degree, or PageRank when asked and present. */
  score(rankBy = "indegree") {
    return rankBy === "pagerank" && this.rank ? this.rank : this.indeg;
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
   * Where an article stands: "#412 of 6,9M" by in-degree, and by PageRank when there
   * is one. A sorted copy of each signal, made on first use (a second for enwiki, 28
   * MB), then a binary search per question: the position is one more than the count
   * of articles scoring strictly higher, so ties share a rank.
   */
  rankOf(idx) {
    if (!this._sorted) {
      this._sorted = {
        indegree: Int32Array.from(this.indeg).sort((a, b) => b - a),
        pagerank: this.rank ? Float32Array.from(this.rank).sort((a, b) => b - a) : null,
      };
    }
    const above = (arr, v) => {           // count of entries strictly greater than v
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] > v) lo = mid + 1; else hi = mid; }
      return lo;
    };
    return {
      indegree: above(this._sorted.indegree, this.indeg[idx]) + 1,
      pagerank: this._sorted.pagerank ? above(this._sorted.pagerank, this.rank[idx]) + 1 : null,
    };
  }

  /**
   * One article's facts for the card: what the graph and the database know that the
   * view data does not carry. Categories come with hidden ones left out and the
   * organising ones (stubs, "by year", Wikipedia's own housekeeping) after the ones
   * that describe the subject, since the reader wants the latter first.
   */
  article(idx) {
    const r = this.db.prepare("SELECT title, len, touched, deg, topic FROM node WHERE idx = ?").get(idx);
    if (!r) return null;
    const cats = this.db.prepare(
      `SELECT c.pid, c.title FROM node_cat nc JOIN category c ON c.pid = nc.cat
        WHERE nc.idx = ? AND c.hidden = 0 ORDER BY c.title`).all(idx)
      .map((c) => ({ pid: Number(c.pid), title: String(c.title),
                     organising: ORGANISING_CAT.test(String(c.title)) }))
      .sort((a, b) => a.organising - b.organising);
    const t = String(r.touched);
    return {
      idx, title: String(r.title),
      kind: KIND_NAMES[this.kind[idx]],
      len: Number(r.len),
      touched: t ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : "",
      indeg: this.indeg[idx], outdeg: Number(r.deg),
      topic: r.topic ? String(r.topic) : null,
      rank: this.rankOf(idx), of: this.n,
      categories: cats,
      since: this.since(idx),
      citedBy: this.citedBy(idx),
    };
  }

  /**
   * Who cites an article: its in-neighbours by topic and by kind. The difference
   * between an article that matters and one that is merely enumerated -- a high
   * in-degree that is four fifths list pages is an index entry, not an influence.
   * One GROUP BY per chunk of in-neighbour ids; kinds from the array.
   */
  citedBy(idx) {
    const ids = this.in.neighbours(idx);
    const total = ids.length;
    const topics = new Map();
    const kinds = new Int32Array(KIND_NAMES.length);
    for (let at = 0; at < total; at += 5000) {
      const chunk = Array.from(ids.subarray(at, at + 5000));
      for (const i of chunk) kinds[this.kind[i]]++;
      const ph = chunk.map(() => "?").join(",");
      for (const r of this.db.prepare(`SELECT topic, count(*) AS n FROM node WHERE idx IN (${ph}) GROUP BY topic`).all(...chunk)) {
        const t = r.topic ? String(r.topic).replace(/_/g, " ") : "(uncategorised)";
        topics.set(t, (topics.get(t) ?? 0) + Number(r.n));
      }
    }
    return {
      total,
      topics: [...topics.entries()].sort((a, b) => b[1] - a[1]).map(([topic, n]) => ({ topic, n })),
      kinds: Object.fromEntries(KIND_NAMES.map((k, i) => [k, kinds[i]]).filter(([, n]) => n > 0)),
    };
  }

  /**
   * What changed around an article since the previous build: in-links that arrived
   * and left, as titles. Null without a previous build; `old: false` when the article
   * itself is new. A rename shows as everything lost here and everything gained on
   * the new title, which is what happened to the links.
   */
  since(idx) {
    const prev = this.previous;
    if (!prev) return null;
    const title = this.titleOf(idx);
    const oldIdx = prev.idxOf(title);
    if (oldIdx < 0) return { build: prev.name, old: false, gained: [], lost: [], gainedCount: this.indeg[idx], lostCount: 0 };
    const was = new Set(prev.inTitles(oldIdx));
    const nowIds = this.in.neighbours(idx);
    const now = new Map();   // title -> current idx
    for (let at = 0; at < nowIds.length; at += 5000) {
      const chunk = Array.from(nowIds.subarray(at, at + 5000));
      const ph = chunk.map(() => "?").join(",");
      for (const r of this.db.prepare(`SELECT idx, title FROM node WHERE idx IN (${ph})`).all(...chunk)) now.set(String(r.title), Number(r.idx));
    }
    const gained = [...now.keys()].filter((t) => !was.has(t));
    const lost = [...was].filter((t) => !now.has(t));
    // The most linked-to first, so a hub's hundred arrivals lead with the ones that matter.
    const byDeg = (a, b) => this.indeg[now.get(b)] - this.indeg[now.get(a)];
    const CAP = 150;
    return {
      build: prev.name, old: true,
      gained: gained.sort(byDeg).slice(0, CAP).map(label_), lost: lost.slice(0, CAP).map(label_),
      gainedCount: gained.length, lostCount: lost.length,
      then: was.size, now: now.size,
    };
  }

  /**
   * The lens: which of a view's edges did not exist in the previous build. Given the
   * node titles in view order and the undirected edges as positions, returns the set
   * of edge indices that are new -- no link either way between the two back then.
   */
  newEdges(labels, edges) {
    const prev = this.previous;
    if (!prev) return null;
    const oldIdx = labels.map((t) => prev.idxOf(t.replace(/ /g, "_")));
    const inOf = new Map();   // old idx -> old in-neighbours, read once per node
    const ins = (i) => { let a = inOf.get(i); if (!a) { a = prev.in.neighbours(i); inOf.set(i, a); } return a; };
    const out = new Set();
    edges.forEach((e, k) => {
      const a = oldIdx[e.s], b = oldIdx[e.t];
      if (a < 0 || b < 0) { out.add(k); return; }         // one end did not exist: new
      if (prev.hadLink(a, b, ins(b)) || prev.hadLink(b, a, ins(a))) return;
      out.add(k);
    });
    return out;
  }

  /**
   * The choices a disambiguation page offers: what it links to, the most linked-to
   * first, with each one's topic so "Mercury (planet) · Science" reads at a glance.
   * The kind and category filters apply to the options -- but not the disambiguation
   * filter, whose whole point these options are, and not the length filter: a dab's
   * list is short and a two-paragraph "Mercury (mythology)" is still what was meant.
   */
  dabOptions(idx, { hide = [], within = null, limit = 12 } = {}) {
    const ok = this.allow(hide.filter((k) => k !== "dab"), 0, within);
    const cands = [...this.neighbours(idx)].filter((v) => ok(v) && this.kind[v] !== KIND.dab);
    if (!cands.length) return [];
    const ph = cands.map(() => "?").join(",");
    const rows = new Map(this.db.prepare(`SELECT idx, title, topic FROM node WHERE idx IN (${ph})`).all(...cands)
      .map((r) => [Number(r.idx), r]));
    // A dab page links to its entries -- and to the words that describe them ("a car
    // brand of Ford Motor Company"). The entries carry the name, so they are the
    // choices, by importance; the unnamed links are only offered when there are too
    // few named ones to be sure the name is in the titles at all.
    const name = this.titleOf(idx).toLowerCase().replace(/_\(disambiguation\)$/, "");
    const named = (v) => String(rows.get(v)?.title ?? "").toLowerCase().includes(name) ? 1 : 0;
    const byDeg = (a, b) => this.indeg[b] - this.indeg[a];
    const entries = cands.filter(named).sort(byDeg), other = cands.filter((v) => !named(v)).sort(byDeg);
    const ids = (entries.length >= 3 ? entries : entries.concat(other)).slice(0, limit);
    return ids.map((i) => ({ idx: i, title: String(rows.get(i)?.title ?? i), deg: this.indeg[i],
                             topic: rows.get(i)?.topic ? String(rows.get(i).topic).replace(/_/g, " ") : null }));
  }

  /**
   * Title search, ranked by in-degree.
   *
   * With the FTS5 index: every word the user typed becomes a prefix term, so "alb ein"
   * finds Albert Einstein and "einstein" finds it too -- case-insensitive, diacritics
   * folded. Without it: the old prefix LIKE, fetched wide and re-ranked here.
   */
  search(q, limit = 20, hide = [], minLen = 0, within = null, rankBy = "indegree") {
    const ok = this.allow(hide, minLen, within);
    const score = this.score(rankBy);
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
      // The index can only pre-sort by in-degree; when ranking by PageRank a wider net
      // is fetched and re-ranked here, since the two orders differ in the middle.
      // Older indexes have no alias column; COALESCE keeps them working.
      rows = this.fts
        .prepare("SELECT idx, title, alias FROM titles WHERE titles MATCH ? ORDER BY indeg DESC LIMIT ?")
        .all(match, rankBy === "pagerank" ? limit * 25 : limit * 5)
        .map((r) => ({ idx: Number(r.idx), matched: String(r.title).replace(/ /g, "_"),
                       alias: Number(r.alias) === 1 }));
    } else {
      rows = this.db
        .prepare("SELECT idx, title FROM node WHERE title LIKE ? LIMIT ?")
        .all(text.replace(/ /g, "_") + "%", Math.max(200, limit * 10))
        .map((r) => ({ idx: Number(r.idx), matched: String(r.title), alias: false }));
    }
    // One hit per article. "USA", "U.S." and "United States" all point at the same
    // idx; the article wins the slot, and if only a redirect matched, the hit says so.
    //
    // An alias counts only when it *starts with* what was typed. A redirect inherits
    // its target's importance, so any looser match lets a hub in through a side door:
    // "new york" surfaced *Town* through the redirect "Town (New York)", and "united
    // states" surfaced *Time zone* through "Time in the United States". Titles keep
    // the word-prefix behaviour; aliases are held to the name itself.
    const typed = text.toLowerCase().replace(/_/g, " ");
    // What was typed *is* a disambiguation page: "Mercury". The page itself is not a
    // choice, its options are; they lead the list, flagged, so the box can offer them.
    // Or the typed title has a "(disambiguation)" page beside it, the wiki's way of
    // saying the plain title is the main meaning and here are the others.
    let dab = null;
    for (const t of [text, `${text} (disambiguation)`]) {
      const exact = this.lookup(t);
      if (exact < 0 || this.kind[exact] !== KIND.dab) continue;
      const options = this.dabOptions(exact, { hide, within });
      if (options.length) { dab = { idx: exact, title: this.titleOf(exact), options }; break; }
    }
    const best = new Map();
    for (const h of rows) {
      if (!ok(h.idx)) continue;
      if (h.alias && !h.matched.toLowerCase().replace(/_/g, " ").startsWith(typed)) continue;
      const cur = best.get(h.idx);
      if (!cur || (cur.alias && !h.alias)) best.set(h.idx, h);
    }
    return [...best.values()]
      .map((h) => ({
        idx: h.idx,
        title: h.alias ? this.titleOf(h.idx) : h.matched,
        via: h.alias ? h.matched.replace(/_/g, " ") : undefined,
        deg: this.indeg[h.idx], score: score[h.idx],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .concat(dab ? [{ idx: dab.idx, title: dab.title, dab: true, options: dab.options, deg: this.indeg[dab.idx], score: 0 }] : []);
  }

  /** Category names by prefix, biggest first -- for the category view's typeahead. */
  /**
   * A category's place in the tree: its parents (describing ones first, organising
   * ones flagged so the page can dim them), how many children it has and how many
   * articles are filed directly under it.
   */
  categoryInfo(pid) {
    const row = this.db.prepare("SELECT title, hidden FROM category WHERE pid = ?").get(pid);
    if (!row) return null;
    const parents = this.db.prepare(
      `SELECT c.pid, c.title, c.hidden FROM cat_tree t JOIN category c ON c.pid = t.parent WHERE t.child = ?`).all(pid)
      .map((r) => ({ pid: Number(r.pid), title: String(r.title),
                     organising: Number(r.hidden) === 1 || ORGANISING_CAT.test(String(r.title)) }))
      .sort((a, b) => a.organising - b.organising || a.title.localeCompare(b.title));
    const children = Number(this.db.prepare("SELECT count(*) AS n FROM cat_tree WHERE parent = ?").get(pid).n);
    const articles = Number(this.db.prepare("SELECT count(*) AS n FROM node_cat WHERE cat = ?").get(pid).n);
    return { pid, title: String(row.title), hidden: Number(row.hidden) === 1, parents, children, articles };
  }

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
  neighborhood(seed, { hops = 2, limit = 3000, direction = "both", hide = [], minLen = 0, within = null, rankBy = "indegree" } = {}) {
    const ok = this.allow(hide, minLen, within);
    const score = this.score(rankBy);
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
            if (!seen.has(v) && !next.has(v) && ok(v)) next.set(v, score[v]);
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
   * Articles similar to `seed` by the company they keep: the same articles link to
   * both (co-citation), and both link to the same articles (bibliographic coupling).
   * The "related" question that direct links miss -- two physicists who never cite
   * each other but are named in the same two hundred articles.
   *
   * Counted from the seed outward rather than candidate by candidate: for every z
   * that links to the seed, every article z also links to gets a point; for every w
   * the seed links to, every article that also links to w gets a point. The points
   * are the sizes of the shared neighbour sets, and the score is Jaccard over the
   * combined in+out neighbour sets, |shared| / (deg(seed) + deg(y) - |shared|).
   *
   * Hubs are the cost: an article linking to the seed may have 3,000 out-links, and
   * United States has half a million in-links. So the neighbours are taken smallest
   * degree first -- an article with thirty links that links to Belgium says more about
   * Belgium than a list with three thousand -- and the walk stops at `budget` points.
   * The counts are then lower bounds for whatever was left out, which only ever
   * penalises the hubs, which is the right way round.
   */
  similar(seed, { limit = 300, hide = [], minLen = 0, within = null, budget = 400_000 } = {}) {
    const ok = this.allow(hide, minLen, within);
    const points = new Map();
    let spent = 0;
    // (list of neighbours, the degree that decides their order, the list to walk from each)
    const walk = (nbrs, degOf, from) => {
      const order = Array.from(nbrs).sort((a, b) => degOf(a) - degOf(b));
      for (const z of order) {
        if (spent >= budget) return;
        const list = from(z);
        spent += list.length;
        for (const y of list) {
          if (y === seed) continue;
          points.set(y, (points.get(y) ?? 0) + 1);
        }
      }
    };
    const outDeg = (i) => this.out.degree(i);
    const inDeg = (i) => this.indeg[i];
    walk(this.in.neighbours(seed), outDeg, (z) => this.out.neighbours(z));   // co-citation
    walk(this.out.neighbours(seed), inDeg, (w) => this.in.neighbours(w));     // coupling
    const degSeed = this.indeg[seed] + this.out.degree(seed);
    const scored = [];
    for (const [y, shared] of points) {
      if (shared < 2 || !ok(y)) continue;
      const degY = this.indeg[y] + this.out.degree(y);
      scored.push([y, shared / (degSeed + degY - shared), shared]);
    }
    scored.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
    const top = scored.slice(0, limit);
    return {
      ids: [seed, ...top.map((t) => t[0])],
      score: new Map(top.map((t) => [t[0], t[1]])),
      shared: new Map(top.map((t) => [t[0], t[2]])),
      degSeed, candidates: scored.length, spent,
    };
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
  path(a, b, { maxDepth = 8, maxVisited = 4_000_000, hide = [], minLen = 0, within = null, mutual = false } = {}) {
    if (a === b) return [a];
    // The endpoints are the user's choice and always allowed; a hidden kind, a short
    // article or one outside the category is only refused as a stepping stone.
    // Without this every path went through a list page.
    const ok = this.allow(hide, minLen, within);
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

  /**
   * What two articles have in common: the articles both of them link to, and the
   * articles that link to both.
   *
   * Not the chain between them (that is `path`) but their overlap -- "what connects
   * these two subjects". Four sorted lists, two merges. With `mutual` the question
   * tightens to articles that are mutually linked with both. Ranked by in-degree,
   * and each survivor is labelled with which side it is on so the card can say.
   */
  common(a, b, { limit = 3000, hide = [], minLen = 0, within = null, mutual = false, rankBy = "indegree" } = {}) {
    const ok = this.allow(hide, minLen, within);
    const score = this.score(rankBy);
    let cited, citing;
    if (mutual) {
      cited = citing = intersectSorted(this.mutual(a), this.mutual(b));
    } else {
      cited = intersectSorted(this.out.neighbours(a), this.out.neighbours(b));
      citing = intersectSorted(this.in.neighbours(a), this.in.neighbours(b));
    }
    const role = new Map();
    for (const v of cited) if (v !== a && v !== b && ok(v)) role.set(v, "both link to it");
    for (const v of citing) {
      if (v === a || v === b || !ok(v)) continue;
      role.set(v, role.has(v) ? "linked both ways with both" : "links to both");
    }
    const ids = [...role.keys()].sort((x, y) => score[y] - score[x]).slice(0, limit);
    return { ids, role, cited: cited.length, citing: citing.length };
  }

  /**
   * A random article that passes the filters and is linked to at least `minIn`
   * times -- a starting point with somewhere to go, not an orphan.
   *
   * Rejection sampling first: with the default filters most articles qualify, so a
   * few draws suffice. If they do not -- a tiny `within` category, say -- fall back
   * to one scan collecting every candidate and pick from those; a scan over enwiki
   * is ~50 ms, which is fine for a button but not for the common case.
   */
  random({ hide = [], minLen = 0, within = null, minIn = 20 } = {}) {
    const ok = this.allow(hide, minLen, within);
    const fits = (i) => ok(i) && this.indeg[i] >= minIn;
    for (let tries = 0; tries < 2000; tries++) {
      const i = Math.floor(Math.random() * this.n);
      if (fits(i)) return i;
    }
    const pool = [];
    for (let i = 0; i < this.n; i++) if (fits(i)) pool.push(i);
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    // A category the user narrowed to may hold nothing that well-linked; better a
    // quiet article from it than nothing at all.
    return minIn > 0 ? this.random({ hide, minLen, within, minIn: 0 }) : -1;
  }

  /** Every article filed under `catPid`, walking `depth` levels of subcategories. */
  categorySubtree(catPid, { depth = 3, limit = 3000, hide = [], minLen = 0 } = {}) {
    const ok = this.allow(hide, minLen);
    const kids = this.db.prepare(`SELECT t.child AS child, c.title AS title, c.hidden AS hidden
                                  FROM cat_tree t JOIN category c ON c.pid = t.child
                                  WHERE t.parent = ?`);
    const members = this.db.prepare("SELECT idx FROM node_cat WHERE cat = ?");

    // Which direct child of the root each category descends from -- this becomes the
    // wedge, and it is why the walk tracks a branch rather than just a visited set.
    //
    // A category that organises rather than describes (a stub bin, "Physicists by
    // nationality", a hidden maintenance category) is walked through but never
    // becomes a branch of its own: whatever is under it takes the branch of the
    // nearest describing ancestor, or the root. Otherwise "Math stubs" is the
    // largest wedge of Mathematics and thirty nationalities fragment Physicists.
    const branchOf = new Map([[catPid, catPid]]);
    const order = [catPid];
    let level = [catPid];
    for (let d = 0; d < depth; d++) {
      const describing = [], organising = [];
      for (const c of level) {
        for (const r of kids.all(c)) {
          const child = Number(r.child);
          if (branchOf.has(child)) continue;
          const org = Number(r.hidden) === 1 || ORGANISING_CAT.test(String(r.title));
          branchOf.set(child, d === 0 && !org ? child : branchOf.get(c));
          (org ? organising : describing).push(child);
        }
      }
      // An article keeps the first category that claims it, so describing categories
      // go first at every level: an article filed under both "Biologists" and
      // "Biology stubs" belongs to the former.
      const next = describing.concat(organising);
      if (!next.length) break;
      order.push(...next);
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
  top(limit = 3000, hide = [], minLen = 0, within = null, rankBy = "indegree") {
    const ok = this.allow(hide, minLen, within);
    const useRank = rankBy === "pagerank" && this.rank;
    const cacheKey = useRank ? "pagerank" : "indegree";
    if (!this._topOrders.has(cacheKey)) {
      // PageRank is a float in (0, 1); scaled by 2^28 it becomes an integer that keeps
      // ~3.7e-9 of resolution -- plenty to order the top thousands, where the values
      // are 1e-5 and up -- and still packs beside a 24-bit index below 2^53.
      const score = useRank ? this.rank : this.indeg;
      const scale = useRank ? 268435456 : 1;
      const key = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) key[i] = Math.round(score[i] * scale) * 16777216 + i;
      key.sort();
      this._topOrders.set(cacheKey, key);
    }
    const order = this._topOrders.get(cacheKey);
    const out = [];
    for (let k = this.n - 1; k >= 0 && out.length < limit; k--) {
      const idx = order[k] % 16777216;
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
   *           mutual?: boolean, group?: "topic" | "cluster" | "hops",
   *           size?: "degree" | "indegree" | "pagerank" | "length" }} opts
   */
  toVaultData(ids, opts) {
    const { title, wedges = 12, depth, typeOf, mutual = false, size = "degree" } = opts;
    let { wedgeOf, group = "topic" } = opts;
    // Hop wedges need the hops; a view that has none (path, category, top) falls
    // back to the filing rather than drawing everything as one slice.
    if (group === "hops" && !depth) group = "topic";
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
    // Wedge names for hops start with the number: the page orders wedges by name
    // (numeric collation), and the seed belongs first, not after "2 hops away".
    const hopWedge = (h) => (h === 0 ? "0 · the seed" : hopLabel(h));

    // Edges are the selection's induced subgraph: a link is drawn only when both ends
    // made the cut. Degree is recomputed over what is actually shown, because the disc
    // rings notes by the degree it can see -- a global degree would push articles to
    // the centre for links to nodes that are not on screen.
    // With `mutual` an edge is drawn only if it exists in both directions. The first
    // pass collects every directed link inside the selection; the second keeps a pair
    // when its reverse was also seen. Keyed on the selection positions, which are
    // small, rather than on node ids.
    // Every directed link inside the selection is collected first, keyed on the
    // unordered pair, as two bits: 1 when the lower position links to the higher, 2
    // the other way. Then each pair becomes one edge with `d` = 1 (s->t), 2 (t->s) or
    // 3 (both). (An earlier version emitted a pair only from the lower position's own
    // out-links, which silently dropped every one-way link running the other way --
    // about half of them.)
    const n = ids.length;
    const bits = new Map();
    for (const id of ids) {
      const from = pos.get(id);
      for (const v of this.neighbours(id)) {
        const to = pos.get(v);
        if (to === undefined || to === from) continue;
        const key = from < to ? from * n + to : to * n + from;
        bits.set(key, (bits.get(key) ?? 0) | (from < to ? 1 : 2));
      }
    }
    const edges = [];
    const degOnDisc = new Int32Array(n);
    for (const [key, d] of bits) {
      if (mutual && d !== 3) continue;
      const s = Math.floor(key / n), t = key % n;
      edges.push({ s, t, w: 1, d });
      degOnDisc[s]++; degOnDisc[t]++;
    }

    // Clustering replaces the grouping with the link structure's own: communities
    // found by modularity on the drawn edges, each named after its three most
    // linked-to members so a wedge reads as a subject rather than a number. The
    // topic wedges are how the wiki files these articles; this is how they actually
    // hang together, and where the two disagree is the interesting part.
    let wedgeNames = null;
    let pool = true;
    // By hop distance the wedges are the shells of the neighbourhood: the seed, what it
    // links to, what those link to. Never pooled -- the seed is a wedge of one, and
    // three shells are the whole point, not a legend to trim.
    if (group === "hops") {
      wedgeOf = new Map(ids.map((id) => [id, depth.get(id) ?? 0]));
      wedgeNames = new Map([...new Set(wedgeOf.values())].map((h) => [h, hopWedge(h)]));
      pool = false;
    }
    if (group === "cluster" && edges.length) {
      const comm = louvain(n, edges.map((e) => [e.s, e.t]), ids.map((i) => this.indeg[i]));
      wedgeOf = new Map(ids.map((id, i) => [id, comm[i]]));
      const members = new Map();
      ids.forEach((id, i) => {
        if (!members.has(comm[i])) members.set(comm[i], []);
        members.get(comm[i]).push(id);
      });
      wedgeNames = new Map();
      for (const [c, ms] of members) {
        const top = ms.sort((a, b) => this.indeg[b] - this.indeg[a]).slice(0, 3)
          .map((id) => label(this.titleOf(id)));
        wedgeNames.set(c, top.join(", "));
      }
    }

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
      // A wedge of one or two articles is a legend entry, not a slice of the disc:
      // below three members a group is pooled whatever its rank.
      const keep = new Set(pool
        ? [...freq.entries()].filter(([, c]) => c >= 3)
            .sort((a, b) => b[1] - a[1]).slice(0, wedges).map(([w]) => w)
        : freq.keys());
      const pooled = [...freq.keys()].filter((w) => !keep.has(w)).length;
      for (const [id, w] of wedgeOf) if (!keep.has(w)) wedgeOf.set(id, POOL);
      catName = wedgeNames ?? this._catNames([...keep]);
      if (pooled) catName.set(POOL, wedgeNames ? `(${pooled} smaller clusters)`
                                               : `(${pooled} smaller subcategories)`);
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
        return c === undefined ? (wedgeNames ? "(unlinked)" : "(uncategorised)")
                               : wedgeNames ? String(catName.get(c) ?? "?") : label(catName.get(c) ?? "?");
      }
      const t = rows.get(id)?.topic;
      if (!t) return "(uncategorised)";
      return allow.has(t) ? label(t) : "(other topics)";
    };

    // Dot size. The page sizes a dot by its degree on the disc, which is also what
    // places it (hubs inward). Another signal goes along as `size`, 0..1, and the
    // page uses it for the radius only, so the layout does not change under the
    // reader's feet when they switch lenses. Log-scaled and normalised over the
    // selection: in-degree runs from one to half a million, and on a linear scale
    // every dot but United States would be the minimum.
    let sizeOf = null;
    if (size !== "degree" && n) {
      const raw = size === "pagerank" && this.rank
        ? (id) => this.rank[id] * this.n            // ~1 for an average article
        : size === "length" ? (id) => Number(rows.get(id)?.len ?? 0)
        : (id) => this.indeg[id];
      const v = ids.map((id) => Math.log1p(Math.max(0, raw(id))));
      let lo = Infinity, hi = -Infinity;
      for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
      const span = hi - lo;
      sizeOf = (i) => (span > 0 ? (v[i] - lo) / span : 0.5);
    }

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
        deg: degOnDisc[pos.get(id)],
        // The article's standing in the whole wiki, beside its degree on this disc.
        indeg: this.indeg[id],
        ...(sizeOf ? { size: Number(sizeOf(pos.get(id)).toFixed(3)) } : {}),
      };
    });

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
