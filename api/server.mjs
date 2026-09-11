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
import { WikiGraph } from "./graph.mjs";

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
for (const ext of ["csr", "db"]) {
  const want = join(GRAPH_DIR, `${WIKI}.${ext}`);
  if (existsSync(want)) continue;
  const have = existsSync(GRAPH_DIR)
    ? readdirSync(GRAPH_DIR).filter((f) => /\.(csr|db)$/.test(f)).sort()
    : [];
  const hint = have.length
    ? `${GRAPH_DIR} holds: ${have.join(", ")} -- is WIKI set in .env? ` +
      `(WIKI is "${WIKI}"${process.env.WIKI ? "" : ", the default: no WIKI in the environment"})`
    : `${GRAPH_DIR} holds no graph at all -- run the ingest first, ` +
      `and check DATA_DIR points at the NAS`;
  console.error(`wikigraph: no ${want}\n  ${hint}`);
  process.exit(1);
}

const graph = new WikiGraph(join(GRAPH_DIR, `${WIKI}.csr`), join(GRAPH_DIR, `${WIKI}.db`));
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
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
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
          // kiwix-serve exposes an article at /content/<book>/<Title>. The book name
          // is the ZIM's filename without its extension.
          reader: KIWIX_URL && KIWIX_BOOK ? `${KIWIX_URL}/content/${KIWIX_BOOK}` : null,
        });

      case "/api/search":
        return json(res, 200, graph.search(q.get("q") ?? "", budget(q.get("limit"), 20)));

      /* Every view returns the same VAULT_DATA shape; only the selection differs. */
      case "/api/view/neighborhood": {
        const seed = graph.lookup(q.get("title") ?? "");
        if (seed < 0) return json(res, 404, { error: `no article "${q.get("title")}"` });
        const limit = budget(q.get("limit"), 3000);
        const hops = Math.max(1, Math.min(4, Number(q.get("hops")) || 2));
        const sel = graph.neighborhood(seed, { hops, limit });
        const title = graph.db.prepare("SELECT title FROM node WHERE idx = ?").get(seed).title;
        return json(res, 200, graph.toVaultData(sel.ids, {
          title: String(title).replace(/_/g, " "), depth: sel.depth,
        }));
      }

      case "/api/view/category": {
        const pid = graph.findCategory(q.get("title") ?? "");
        if (pid < 0) return json(res, 404, { error: `no category "${q.get("title")}"` });
        const sel = graph.categorySubtree(pid, {
          depth: Math.max(1, Math.min(6, Number(q.get("depth")) || 3)),
          limit: budget(q.get("limit"), 3000),
        });
        if (!sel.ids.length) return json(res, 404, { error: "category holds no articles" });
        return json(res, 200, graph.toVaultData(sel.ids, {
          title: `Category: ${String(q.get("title")).replace(/_/g, " ")}`,
          wedgeOf: sel.branch,
        }));
      }

      case "/api/view/top":
        return json(res, 200, graph.toVaultData(graph.top(budget(q.get("limit"), 2000)), {
          title: `${WIKI} — best connected`,
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
