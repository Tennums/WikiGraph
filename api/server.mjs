/**
 * HTTP front end: static page, view queries, and a redirect into Kiwix for reading.
 *
 * Deliberately dependency-free -- node:http, node:sqlite and the CSR reader are the
 * whole stack, so the container is a plain `node:24-alpine` with the source copied in
 * and nothing to audit or update.
 */

import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WikiGraph, KIND_NAMES } from "./graph.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const WIKI = process.env.WIKI ?? "simplewiki";
const GRAPH_DIR = process.env.GRAPH_DIR ?? "data/graph";
const WEB_DIR = process.env.WEB_DIR ?? "web";
// Where a click on a dot sends the reader. Empty disables the link entirely, which is
// the right default until a ZIM is actually mounted.
const KIWIX_URL = (process.env.KIWIX_URL ?? "").replace(/\/$/, "");
const KIWIX_BOOK = process.env.KIWIX_BOOK ?? "";
const MAX_NODES = Number(process.env.MAX_NODES ?? 6000);

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
                            join(GRAPH_DIR, `${WIKI}.search.db`));
if (!graph.fts) {
  console.log(`wikigraph: no ${WIKI}.search.db -- title search is prefix-only; build it with\n` +
              `  docker compose --profile ingest run --rm ingest --wiki ${WIKI} --index-only`);
}
console.log(`wikigraph: ${WIKI} — ${graph.n.toLocaleString()} articles, ` +
            `${graph.m.toLocaleString()} links`);

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams;

  try {
    switch (url.pathname) {
      case "/api/info":
        return json(res, 200, {
          ...graph.meta,
          maxNodes: MAX_NODES,
          kinds: Object.fromEntries(KIND_NAMES.map((k, i) => [k, graph.kindCounts[i]])),
          search: graph.fts ? "fulltext" : "prefix",
          // kiwix-serve exposes an article at /content/<book>/<Title>. The book name
          // is the ZIM's filename without its extension.
          reader: KIWIX_URL && KIWIX_BOOK ? `${KIWIX_URL}/content/${KIWIX_BOOK}` : null,
        });

      case "/api/search":
        return json(res, 200, q.get("kind") === "category"
          ? graph.searchCategories(q.get("q") ?? "", budget(q.get("limit"), 20))
          : graph.search(q.get("q") ?? "", budget(q.get("limit"), 20), hidden(q)));

      /* Every view returns the same VAULT_DATA shape; only the selection differs. */
      case "/api/view/neighborhood": {
        const seed = graph.lookup(q.get("title") ?? "");
        if (seed < 0) return json(res, 404, { error: `no article "${q.get("title")}"` });
        const limit = budget(q.get("limit"), 3000);
        const hops = Math.max(1, Math.min(4, Number(q.get("hops")) || 2));
        const direction = ["in", "out", "both"].includes(q.get("direction"))
          ? q.get("direction") : "both";
        const sel = graph.neighborhood(seed, { hops, limit, direction, hide: hidden(q) });
        const name = graph.titleOf(seed).replace(/_/g, " ");
        const title = direction === "in" ? `What links to ${name}`
                    : direction === "out" ? `What ${name} links to` : name;
        return json(res, 200, graph.toVaultData(sel.ids, { title, depth: sel.depth }));
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
        const hide = hidden(q);
        const path = graph.path(a, b, { hide });
        if (!path) return json(res, 404, { error: "no link path found within 8 hops" });
        const limit = budget(q.get("limit"), 2500);
        const onPath = new Set(path);
        const ids = [...path];
        // Share the budget across the chain so a hub on the path cannot crowd out
        // the rest of it.
        const per = Math.max(20, Math.floor((limit - path.length) / path.length));
        for (const u of path) {
          const near = graph.neighborhood(u, { hops: 1, limit: per + 1, direction: "both", hide });
          for (const v of near.ids) if (!onPath.has(v) && ids.length < limit) { ids.push(v); onPath.add(v); }
        }
        const names = path.map((i) => graph.titleOf(i).replace(/_/g, " "));
        const data = graph.toVaultData(ids, {
          title: `${names[0]} → ${names[names.length - 1]} (${path.length - 1} hops)`,
          typeOf: (id) => path.includes(id) ? `step ${path.indexOf(id)} of ${path.length - 1}` : "along the path",
        });
        data.path = path.map(String);
        data.pathTitles = names;
        data.pathMs = Date.now() - t0;
        return json(res, 200, data);
      }

      case "/api/view/category": {
        const pid = graph.findCategory(q.get("title") ?? "");
        if (pid < 0) return json(res, 404, { error: `no category "${q.get("title")}"` });
        const sel = graph.categorySubtree(pid, {
          depth: Math.max(1, Math.min(6, Number(q.get("depth")) || 3)),
          limit: budget(q.get("limit"), 3000),
          hide: hidden(q),
        });
        if (!sel.ids.length) return json(res, 404, { error: "category holds no articles" });
        return json(res, 200, graph.toVaultData(sel.ids, {
          title: `Category: ${String(q.get("title")).replace(/_/g, " ")}`,
          wedgeOf: sel.branch,
        }));
      }

      case "/api/view/top":
        return json(res, 200, graph.toVaultData(graph.top(budget(q.get("limit"), 2000), hidden(q)), {
          title: `${WIKI} — most linked-to`,
        }));

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
