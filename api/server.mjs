/**
 * HTTP front end: static page, view queries, and a redirect into Kiwix for reading.
 *
 * Deliberately dependency-free -- node:http, node:sqlite and the CSR reader are the
 * whole stack, so the container is a plain `node:24-alpine` with the source copied in
 * and nothing to audit or update.
 */

import { createServer, request as httpRequest } from "node:http";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join, normalize } from "node:path";
import { WikiGraph, KIND_NAMES } from "./graph.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const WIKI = process.env.WIKI ?? "simplewiki";
// A graph directory holds either one build flat (`enwiki.csr` and friends) or dated
// builds beside a `current` link to the one in use -- the layout the monthly refresh
// makes (`refresh.sh`), so a new build can be made and compared while the old one
// serves, then swapped in with one restart. `current` wins when it is there; a flat
// build beside it is the one the refresh superseded and can be deleted.
const GRAPH_ROOT = process.env.GRAPH_DIR ?? "data/graph";
const GRAPH_DIR = (() => {
  const cur = join(GRAPH_ROOT, "current");
  try { return statSync(cur).isDirectory() ? cur : GRAPH_ROOT; } catch { return GRAPH_ROOT; }
})();
// The build's own name, for /api/info: the dated directory `current` points at, or
// nothing for a flat layout.
const BUILD = GRAPH_DIR === GRAPH_ROOT ? null : basename(realpathSync(GRAPH_DIR));
const WEB_DIR = process.env.WEB_DIR ?? "web";
// Where a click on a dot sends the reader. Empty disables the link entirely, which is
// the right default until a ZIM is actually mounted.
const KIWIX_URL = (process.env.KIWIX_URL ?? "").replace(/\/$/, "");
const KIWIX_BOOK = process.env.KIWIX_BOOK ?? "";
const MAX_NODES = Number(process.env.MAX_NODES ?? 6000);
// Development only. In production Caddy routes /kiwix/* to the kiwix container on the
// same hostname, which is what lets the page fetch article text same-origin. With no
// Caddy in front (a laptop, or a single-port setup) this forwards the same prefix to a
// kiwix-serve running elsewhere, so the same-origin path can be exercised as is.
const KIWIX_PROXY = (process.env.KIWIX_PROXY ?? "").replace(/\/$/, "");

// Fail with a sentence, not a stack trace. The usual cause of a missing graph is not a
// missing graph: it is WIKI falling back to its default because .env is absent -- a
// fresh clone has no .env, since it is deliberately untracked -- and an ENOENT for
// simplewiki.csr says nothing about that while the enwiki graph sits right beside it.
for (const ext of ["csr", "rcsr", "db", "kind"]) {
  const want = join(GRAPH_DIR, `${WIKI}.${ext}`);
  if (existsSync(want)) continue;
  const have = existsSync(GRAPH_DIR)
    ? readdirSync(GRAPH_DIR).filter((f) => /\.(csr|rcsr|db|kind)$/.test(f)).sort()
    : [];
  const hint = ext === "rcsr" && have.includes(`${WIKI}.csr`)
    ? `the in-link graph is missing; derive it from the existing .csr with\n  ` +
      `docker compose --profile ingest run --rm ingest --wiki ${WIKI} --reverse-only`
    : ext === "kind" && have.includes(`${WIKI}.db`)
    ? `the article-kind file is missing; label the existing build with\n  ` +
      `docker compose --profile ingest run --rm ingest --wiki ${WIKI} --classify-only`
    : have.length
    ? `${GRAPH_DIR} holds: ${have.join(", ")} -- is WIKI set in .env? ` +
      `(WIKI is "${WIKI}"${process.env.WIKI ? "" : ", the default: no WIKI in the environment"})`
    : `${GRAPH_DIR} holds no graph at all -- run the ingest first, ` +
      `and check DATA_DIR points at the NAS`;
  console.error(`wikigraph: no ${want}\n  ${hint}`);
  process.exit(1);
}

const graph = new WikiGraph(join(GRAPH_DIR, `${WIKI}.csr`), join(GRAPH_DIR, `${WIKI}.rcsr`),
                            join(GRAPH_DIR, `${WIKI}.db`), join(GRAPH_DIR, `${WIKI}.kind`),
                            join(GRAPH_DIR, `${WIKI}.search.db`), join(GRAPH_DIR, `${WIKI}.rank`));
if (!graph.rank) {
  console.log(`wikigraph: no ${WIKI}.rank -- ranking by in-degree only; add PageRank with\n` +
              `  docker compose --profile ingest run --rm ingest --wiki ${WIKI} --rank-only`);
}
if (!graph.fts) {
  console.log(`wikigraph: no ${WIKI}.search.db -- title search is prefix-only; build it with\n` +
              `  docker compose --profile ingest run --rm ingest --wiki ${WIKI} --index-only`);
}
console.log(`wikigraph: ${WIKI} — ${graph.n.toLocaleString()} articles, ` +
            `${graph.m.toLocaleString()} links` + (BUILD ? ` (build ${BUILD})` : "") +
            ` from ${GRAPH_DIR}`);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml",
};

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "content-type": MIME[".json"], "content-length": buf.length });
  res.end(buf);
};

/** Clamp to the budget the renderer can actually animate. */
const budget = (v, dflt) => Math.max(1, Math.min(MAX_NODES, Number(v) || dflt));

/** `minlen=1000` -> skip articles shorter than this many bytes of wikitext. */
const MIN_LEN_DEFAULT = Number(process.env.MIN_LEN_DEFAULT ?? 1000);
const minLen = (q) => {
  const v = q.get("minlen");
  return v === null ? MIN_LEN_DEFAULT : Math.max(0, Math.min(100_000, Number(v) || 0));
};

/**
 * `within=Science&withindepth=3` -> a membership mask, or null. Resolved once per
 * request; an unknown category is reported rather than silently ignored, since a
 * filter that quietly does nothing is worse than one that fails.
 */
const within = (q) => {
  const name = (q.get("within") ?? "").trim();
  if (!name) return { mask: null, name: "" };
  const pid = graph.findCategory(name);
  if (pid < 0) return { error: `no category "${name}"` };
  const depth = Math.max(1, Math.min(6, Number(q.get("withindepth")) || 3));
  return { mask: graph.categoryMask(pid, depth), name: name.replace(/_/g, " ") };
};

/**
 * Node keys on the disc are positions in `nodes`, not article ids -- the page keys its
 * store by index, which is also what edges' s/t refer to. Anything handed to the page
 * that names nodes (pins) has to be translated.
 */
/** A JSON request body, capped at 4 MB; anything else is an empty object. */
const readJson = (req) => new Promise((resolve) => {
  const chunks = []; let size = 0;
  req.on("data", (c) => { size += c.length; if (size <= 4e6) chunks.push(c); });
  req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve({}); } });
  req.on("error", () => resolve({}));
});

const positionsOf = (ids, articleIds) => {
  const pos = new Map(ids.map((id, i) => [id, i]));
  return articleIds.map((a) => pos.get(a)).filter((i) => i !== undefined).map(String);
};

/** `rank=pagerank` -> rank frontiers, search and the top list by PageRank instead of in-degree. */
const rankBy = (q) => (q.get("rank") === "pagerank" && graph.rank ? "pagerank" : "indegree");

/** `group=cluster|hops` -> wedges from the link structure itself, or from hop distance, not the topic filing. */
const groupBy = (q) => (["cluster", "hops"].includes(q.get("group")) ? q.get("group") : "topic");

/** `size=indegree|pagerank|length` -> what a dot's radius reflects; the default is its degree on the disc. */
const sizeBy = (q) => {
  const v = q.get("size");
  return v === "pagerank" ? (graph.rank ? "pagerank" : "indegree")
       : ["indegree", "length"].includes(v) ? v : "degree";
};

/** `mutual=1` -> draw and follow only links that go both ways. */
const wantMutual = (q) => ["1", "true", "yes"].includes(q.get("mutual") ?? "");

/** `hide=list,date,dab,infra` -> the kind names to leave out of a selection. */
const hidden = (q) => (q.get("hide") ?? "").split(",").map((x) => x.trim())
  .filter((x) => KIND_NAMES.includes(x) && x !== "article");

async function serveStatic(url, res) {
  // normalize() before the prefix check: without it "/../api/graph.mjs" escapes WEB_DIR.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const path = join(WEB_DIR, rel === "/" ? "index.html" : rel);
  if (!path.startsWith(normalize(WEB_DIR))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      // Revalidate every time. The files are small and served from the container's
      // own disk, and without this a browser keeps the previous page.js for days after
      // a rebuild -- a new feature "not working" that is really an old bundle.
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function proxyKiwix(req, res) {
  const target = new URL(req.url, KIWIX_PROXY);
  const up = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } },
    (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(502).end("kiwix unreachable"); });
  req.pipe(up);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams;

  if (KIWIX_PROXY && url.pathname.startsWith("/kiwix")) return proxyKiwix(req, res);

  try {
    switch (url.pathname) {
      case "/api/info":
        return json(res, 200, {
          ...graph.meta,
          build: BUILD,
          maxNodes: MAX_NODES,
          kinds: Object.fromEntries(KIND_NAMES.map((k, i) => [k, graph.kindCounts[i]])),
          search: graph.fts ? "fulltext" : "prefix",
          pagerank: !!graph.rank,
          minLenDefault: MIN_LEN_DEFAULT,
          // kiwix-serve exposes an article at /content/<book>/<Title>. The book name
          // is the ZIM's filename without its extension.
          reader: KIWIX_URL && KIWIX_BOOK ? `${KIWIX_URL}/content/${KIWIX_BOOK}` : null,
          // And its full-text search, an RSS feed of hits over the ZIM's own index:
          // append &pattern=...&start=...&pageLength=... (140 per page at most).
          textSearch: KIWIX_URL && KIWIX_BOOK ? `${KIWIX_URL}/search?content=${KIWIX_BOOK}&format=xml` : null,
        });

      /* An explicit list of titles drawn as a disc -- the page's full-text view sends
         Kiwix's hits here. Titles in the order the caller ranks them; that order becomes
         the dot size (first hit largest) unless a size lens is chosen. Filters apply,
         except that they cannot be told apart from "not an article" here, so the count
         of titles that did not resolve is returned as `unresolved`. */
      case "/api/view/set": {
        if (req.method !== "POST") return json(res, 405, { error: "POST a JSON body {titles, title}" });
        const body = await readJson(req);
        if (!Array.isArray(body?.titles)) return json(res, 400, { error: "titles: string[] required" });
        const w = within(q);
        if (w.error) return json(res, 404, { error: w.error });
        const ok = graph.allow(hidden(q), minLen(q), w.mask);
        const limit = budget(q.get("limit"), 2000);
        const ids = [], rank = new Map();
        let unresolved = 0, filtered = 0;
        for (const t of body.titles.slice(0, 20000)) {
          if (ids.length >= limit) break;
          const i = graph.lookup(String(t));
          if (i < 0) { unresolved++; continue; }
          if (rank.has(i)) continue;
          if (!ok(i)) { filtered++; continue; }
          rank.set(i, ids.length); ids.push(i);
        }
        if (!ids.length) return json(res, 404, { error: "none of the titles is an article that passes the filters" });
        const data = graph.toVaultData(ids, {
          title: String(body.title ?? "a set of articles").slice(0, 200) + (w.name ? ` · within ${w.name}` : ""),
          mutual: wantMutual(q), group: groupBy(q), size: sizeBy(q),
          typeOf: (id) => `hit #${rank.get(id) + 1}`,
        });
        if (sizeBy(q) === "degree") {
          // Rank as size: the first hit the largest, the tail small but not vanishing.
          const n = ids.length;
          data.nodes.forEach((node, i) => { node.size = Number((1 - Math.log1p(i) / Math.log1p(n)).toFixed(3)); });
        }
        data.set = { given: body.titles.length, drawn: ids.length, unresolved, filtered };
        if (w.mask) data.within = { name: w.name, articles: w.mask.count, categories: w.mask.categories };
        return json(res, 200, data);
      }

      case "/api/search": {
        if (q.get("kind") === "category") {
          return json(res, 200, graph.searchCategories(q.get("q") ?? "", budget(q.get("limit"), 20)));
        }
        const w = within(q);
        if (w.error) return json(res, 200, []);
        return json(res, 200, graph.search(q.get("q") ?? "", budget(q.get("limit"), 20), hidden(q), minLen(q), w.mask, rankBy(q)));
      }

      case "/api/random": {
        const w = within(q);
        if (w.error) return json(res, 404, { error: w.error });
        const i = graph.random({ hide: hidden(q), minLen: minLen(q), within: w.mask });
        if (i < 0) return json(res, 404, { error: "nothing passes the current filters" });
        return json(res, 200, { idx: i, title: graph.titleOf(i).replace(/_/g, " "), indeg: graph.indeg[i] });
      }

      /* One article's facts, for the card: rank, categories, degrees. */
      case "/api/article": {
        const i = graph.lookup(q.get("title") ?? "");
        if (i < 0) return json(res, 404, { error: `no article "${q.get("title")}"` });
        return json(res, 200, graph.article(i));
      }

      /* Every view returns the same VAULT_DATA shape; only the selection differs. */
      case "/api/view/neighborhood": {
        const seed = graph.lookup(q.get("title") ?? "");
        if (seed < 0) return json(res, 404, { error: `no article "${q.get("title")}"` });
        const limit = budget(q.get("limit"), 3000);
        const hops = Math.max(1, Math.min(4, Number(q.get("hops")) || 2));
        const mutual = wantMutual(q);
        // Mutual links are symmetric, so a direction has no meaning once they are the
        // only ones followed; the flag wins.
        const direction = mutual ? "mutual"
          : ["in", "out", "both"].includes(q.get("direction")) ? q.get("direction") : "both";
        const w = within(q);
        if (w.error) return json(res, 404, { error: w.error });
        const sel = graph.neighborhood(seed, { hops, limit, direction, hide: hidden(q), minLen: minLen(q), within: w.mask, rankBy: rankBy(q) });
        const name = graph.titleOf(seed).replace(/_/g, " ");
        const title = (direction === "in" ? `What links to ${name}`
                    : direction === "out" ? `What ${name} links to`
                    : direction === "mutual" ? `${name} — mutual links` : name)
                    + (w.name ? ` · within ${w.name}` : "");
        const data = graph.toVaultData(sel.ids, { title, depth: sel.depth, mutual, group: groupBy(q), size: sizeBy(q) });
        // The article the disc is drawn around sits in the hub, as a path's steps do:
        // the one dot the view is about should never have to be found on the rim.
        data.pinned = positionsOf(sel.ids, [seed]);
        if (w.mask) data.within = { name: w.name, articles: w.mask.count, categories: w.mask.categories };
        return json(res, 200, data);
      }

      /* The shortest chain of links between two articles, drawn in context: the path
         itself is pinned to the hub, and each of its articles brings a slice of its
         own neighbourhood so the disc shows what the chain passes through. */
      case "/api/view/path": {
        const a = graph.lookup(q.get("from") ?? "");
        const b = graph.lookup(q.get("to") ?? "");
        if (a < 0) return json(res, 404, { error: `no article "${q.get("from")}"` });
        if (b < 0) return json(res, 404, { error: `no article "${q.get("to")}"` });
        const t0 = Date.now();
        const hide = hidden(q), min = minLen(q);
        const mutual = wantMutual(q);
        const w = within(q);
        if (w.error) return json(res, 404, { error: w.error });
        const path = graph.path(a, b, { hide, minLen: min, within: w.mask, mutual });
        if (!path) return json(res, 404, { error: "no link path found within 8 hops" });
        const limit = budget(q.get("limit"), 2500);
        const onPath = new Set(path);
        const ids = [...path];
        // Share the budget across the chain so a hub on the path cannot crowd out
        // the rest of it.
        const per = Math.max(20, Math.floor((limit - path.length) / path.length));
        for (const u of path) {
          const near = graph.neighborhood(u, { hops: 1, limit: per + 1, hide, minLen: min,
                                               within: w.mask, direction: mutual ? "mutual" : "both",
                                               rankBy: rankBy(q) });
          for (const v of near.ids) if (!onPath.has(v) && ids.length < limit) { ids.push(v); onPath.add(v); }
        }
        const names = path.map((i) => graph.titleOf(i).replace(/_/g, " "));
        const data = graph.toVaultData(ids, {
          mutual, group: groupBy(q), size: sizeBy(q),
          title: `${names[0]} → ${names[names.length - 1]} (${path.length - 1} hops)` +
                 (w.name ? ` · within ${w.name}` : ""),
          typeOf: (id) => path.includes(id) ? `step ${path.indexOf(id)} of ${path.length - 1}` : "along the path",
        });
        data.path = path.map(String);
        data.pinned = positionsOf(ids, path);
        data.pathTitles = names;
        data.pathMs = Date.now() - t0;
        return json(res, 200, data);
      }

      /* The overlap of two articles: what both link to, and who links to both. The two
         seeds are pinned to the hub; everything else is their common ground. */
      case "/api/view/common": {
        const a = graph.lookup(q.get("from") ?? "");
        const b = graph.lookup(q.get("to") ?? "");
        if (a < 0) return json(res, 404, { error: `no article "${q.get("from")}"` });
        if (b < 0) return json(res, 404, { error: `no article "${q.get("to")}"` });
        if (a === b) return json(res, 400, { error: "pick two different articles" });
        const mutual = wantMutual(q);
        const w = within(q);
        if (w.error) return json(res, 404, { error: w.error });
        const sel = graph.common(a, b, {
          limit: budget(q.get("limit"), 2500) - 2, hide: hidden(q), minLen: minLen(q),
          within: w.mask, mutual, rankBy: rankBy(q),
        });
        const names = [graph.titleOf(a), graph.titleOf(b)].map((t) => t.replace(/_/g, " "));
        if (!sel.ids.length) {
          return json(res, 404, {
            error: `${names[0]} and ${names[1]} have no articles in common` +
                   (mutual ? " by mutual links" : "") +
                   (sel.cited + sel.citing ? " that pass the current filters" : ""),
          });
        }
        const data = graph.toVaultData([a, b, ...sel.ids], {
          mutual, group: groupBy(q), size: sizeBy(q),
          title: `${names[0]} × ${names[1]}` + (w.name ? ` · within ${w.name}` : ""),
          typeOf: (id) => id === a || id === b ? "the seed" : sel.role.get(id),
        });
        data.path = [String(a), String(b)];
        data.pinned = positionsOf([a, b, ...sel.ids], [a, b]);
        data.common = { cited: sel.cited, citing: sel.citing, shown: sel.ids.length };
        return json(res, 200, data);
      }

      case "/api/view/category": {
        const pid = graph.findCategory(q.get("title") ?? "");
        if (pid < 0) return json(res, 404, { error: `no category "${q.get("title")}"` });
        const sel = graph.categorySubtree(pid, {
          depth: Math.max(1, Math.min(6, Number(q.get("depth")) || 3)),
          limit: budget(q.get("limit"), 3000),
          hide: hidden(q),
          minLen: minLen(q),
        });
        if (!sel.ids.length) return json(res, 404, { error: "category holds no articles" });
        return json(res, 200, graph.toVaultData(sel.ids, {
          title: `Category: ${String(q.get("title")).replace(/_/g, " ")}`,
          wedgeOf: sel.branch,
          mutual: wantMutual(q),
          group: groupBy(q), size: sizeBy(q),
        }));
      }

      case "/api/view/top": {
        const w = within(q);
        if (w.error) return json(res, 404, { error: w.error });
        return json(res, 200, graph.toVaultData(
          graph.top(budget(q.get("limit"), 2000), hidden(q), minLen(q), w.mask, rankBy(q)), {
            title: `${WIKI} — ${rankBy(q) === "pagerank" ? "highest PageRank" : "most linked-to"}` +
                   (w.name ? ` within ${w.name}` : ""),
            mutual: wantMutual(q),
            group: groupBy(q), size: sizeBy(q),
          }));
      }

      default:
        return serveStatic(url, res);
    }
  } catch (err) {
    console.error(`${url.pathname}: ${err.stack}`);
    return json(res, 500, { error: String(err.message ?? err) });
  }
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => { graph.close(); process.exit(0); }));
}
