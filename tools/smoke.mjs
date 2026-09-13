#!/usr/bin/env node
/**
 * Smoke test: every API route once, against a real build.
 *
 *   node tools/smoke.mjs [graph dir]        default data/graph, WIKI from the env (simplewiki)
 *
 * Starts api/server.mjs on a free port, waits for it, and asks each route one question
 * whose answer is known -- the shape always, a fact where the wiki gives one (Albert
 * Einstein first for "einstein"; Cheese to Black hole in three hops on simplewiki).
 * Nothing here is a unit test; it is the tour a person would make after a change, done
 * in two seconds by a machine so it is actually made. Exits non-zero on the first
 * surprise, with node:test's own report.
 *
 * Facts are simplewiki's. Against another wiki the shape checks still run and the
 * fact checks are skipped (SMOKE_FACTS=0), since "Cheese" is three hops from a black
 * hole only in Simple English.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_DIR = resolve(process.argv[2] ?? join(ROOT, "data/graph"));
const WIKI = process.env.WIKI ?? "simplewiki";
const FACTS = process.env.SMOKE_FACTS !== "0" && WIKI === "simplewiki";

if (!existsSync(GRAPH_DIR)) {
  console.error(`smoke: no graph dir ${GRAPH_DIR}`);
  process.exit(2);
}

// ---- the server -----------------------------------------------------------------
const port = await new Promise((ok) => {
  const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); });
});
const server = spawn(process.execPath, [join(ROOT, "api/server.mjs")], {
  env: { ...process.env, PORT: String(port), GRAPH_DIR, WIKI, WEB_DIR: join(ROOT, "web"),
         STATE_DIR: process.env.STATE_DIR ?? join(tmpdir(), `wikigraph-smoke-state-${process.pid}`) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
const stop = () => { if (!server.killed) server.kill(); };
process.on("exit", stop);

const base = `http://127.0.0.1:${port}`;
const get = async (path) => {
  const res = await fetch(base + path);
  const body = await res.json();
  return { status: res.status, body };
};
const post = async (path, json) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  return { status: res.status, body: await res.json() };
};

// wait for it
{
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 60000) {
    if (server.exitCode !== null) break;
    try { const r = await fetch(`${base}/api/info`); if (r.ok) { up = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    console.error(`smoke: the API did not come up on ${base}\n${serverLog}`);
    stop(); process.exit(2);
  }
}

// Known before the tests are registered: a test's `skip` is decided at registration,
// and whether there is a previous build decides two of them.
const info = (await get("/api/info")).body;

// ---- helpers ----------------------------------------------------------------------
const label = (t) => String(t).replace(/_/g, " ");
const titles = (data) => data.nodes.map((n) => n.label);
const HIDE = "hide=list,date,dab,infra&minlen=1000";

/** What every view must satisfy: a consistent VAULT_DATA object. */
function checkView(data, { minNodes = 1 } = {}) {
  assert.ok(Array.isArray(data.nodes) && data.nodes.length >= minNodes, `nodes: ${data.nodes?.length}`);
  assert.ok(Array.isArray(data.edges), "edges array");
  assert.equal(typeof data.vault, "string");
  const n = data.nodes.length;
  const pairs = new Set();
  for (const e of data.edges) {
    assert.ok(Number.isInteger(e.s) && e.s >= 0 && e.s < n, `edge s in range: ${e.s}`);
    assert.ok(Number.isInteger(e.t) && e.t >= 0 && e.t < n, `edge t in range: ${e.t}`);
    assert.ok(e.s !== e.t, "no self loops");
    assert.ok(e.s < e.t, "pairs ordered");
    assert.ok([1, 2, 3].includes(e.d), `direction on every edge: ${e.d}`);
    const k = e.s * n + e.t;
    assert.ok(!pairs.has(k), "each pair once");
    pairs.add(k);
  }
  for (const p of data.pinned ?? []) {
    assert.ok(/^\d+$/.test(p) && Number(p) < n, `pinned is a position: ${p}`);
  }
  for (const node of data.nodes) {
    assert.equal(typeof node.label, "string");
    assert.equal(typeof node.folder, "string");
    assert.ok(Number.isInteger(node.deg) && node.deg >= 0, "deg");
    assert.ok(Number.isInteger(node.indeg) && node.indeg >= 0, "indeg on every node");
    if (node.size !== undefined) assert.ok(node.size >= 0 && node.size <= 1, `size in 0..1: ${node.size}`);
  }
  assert.equal(data.stats.nodes, n);
  assert.equal(data.stats.edges, data.edges.length);
}

// ---- info ----------------------------------------------------------------------------
test("info", async () => {
  const r = await get("/api/info");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, info);
  assert.equal(info.wiki, WIKI);
  assert.ok(Number(info.nodes) > 1000 && Number(info.edges) > Number(info.nodes), "counts");
  assert.ok(info.kinds && Number.isInteger(info.kinds.article), "kinds");
  assert.ok(["fulltext", "prefix"].includes(info.search));
  assert.equal(typeof info.pagerank, "boolean");
  assert.ok(Number.isInteger(info.maxNodes) && info.maxNodes >= 1000);
  assert.ok("build" in info && "previous" in info && "reader" in info && "textSearch" in info);
  assert.equal(typeof info.state, "boolean");
});

// ---- search --------------------------------------------------------------------------
test("search: titles, aliases, a disambiguation page", async () => {
  const r = await get(`/api/search?q=einstein&limit=5&${HIDE}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0, "hits");
  for (const h of r.body) {
    assert.ok(Number.isInteger(h.idx) && typeof h.title === "string" && Number.isInteger(h.deg));
  }
  if (FACTS) assert.equal(r.body[0].title, "Albert_Einstein");

  const two = await get(`/api/search?q=alb%20ein&limit=5&${HIDE}`);
  if (FACTS) assert.ok(two.body.some((h) => h.title === "Albert_Einstein"), "word prefixes");

  const usa = await get(`/api/search?q=usa&limit=5&${HIDE}`);
  if (FACTS) {
    const us = usa.body.find((h) => h.title === "United_States");
    assert.ok(us, "usa finds United States");
    assert.equal(us.via, "USA");
  }

  const dab = await get(`/api/search?q=Mercury&limit=5&${HIDE}`);
  const hit = dab.body.find((h) => h.dab);
  if (FACTS) {
    assert.ok(hit, "a dab hit for Mercury");
    assert.ok(hit.options.length >= 3, "options");
    const names = hit.options.map((o) => o.title);
    for (const want of ["Mercury_(planet)", "Mercury_(element)", "Mercury_(mythology)"]) {
      assert.ok(names.includes(want), `${want} among the options`);
    }
    assert.ok(hit.options.every((o) => o.topic === null || typeof o.topic === "string"));
  }

  const cats = await get("/api/search?q=phys&kind=category&limit=5");
  assert.equal(cats.status, 200);
  assert.ok(Array.isArray(cats.body));
  if (FACTS) assert.ok(cats.body.some((c) => /^Physics/.test(c.title)), "category search");

  const empty = await get(`/api/search?q=&${HIDE}`);
  assert.deepEqual(empty.body, []);
});

// ---- article -------------------------------------------------------------------------
test("article: facts, rank, categories, since", async () => {
  const r = await get("/api/article?title=Albert%20Einstein");
  if (!FACTS && r.status === 404) return;
  assert.equal(r.status, 200);
  const a = r.body;
  assert.equal(a.title, "Albert_Einstein");
  assert.equal(a.kind, "article");
  assert.ok(a.len > 1000 && a.indeg > 10 && a.outdeg > 10);
  assert.ok(Number.isInteger(a.rank.indegree) && a.rank.indegree >= 1 && a.rank.indegree <= a.of);
  if (info.pagerank) assert.ok(Number.isInteger(a.rank.pagerank) && a.rank.pagerank >= 1);
  else assert.equal(a.rank.pagerank, null);
  assert.ok(a.categories.length > 0, "categories");
  assert.ok(a.categories.every((c) => typeof c.title === "string" && typeof c.organising === "boolean"));
  // describing categories before organising ones
  const firstOrg = a.categories.findIndex((c) => c.organising);
  if (firstOrg >= 0) assert.ok(a.categories.slice(firstOrg).every((c) => c.organising), "organising last");
  assert.ok(a.citedBy && a.citedBy.total === a.indeg, "citedBy covers every in-link");
  assert.equal(a.citedBy.topics.reduce((s, t) => s + t.n, 0), a.indeg, "topics sum to the in-degree");
  assert.equal(Object.values(a.citedBy.kinds).reduce((s, n) => s + n, 0), a.indeg, "kinds sum to the in-degree");
  if (FACTS) {
    // Biographies link to him as much as physics does: People 42%, Science 30%.
    assert.ok(["People", "Science"].includes(a.citedBy.topics[0].topic), `Einstein cited mostly by ${a.citedBy.topics[0].topic}`);
    const list = (await get("/api/article?title=List%20of%20countries")).body;
    const listy = (list.citedBy.kinds.list ?? 0) + (list.citedBy.kinds.infra ?? 0) + (list.citedBy.kinds.date ?? 0);
    assert.ok(list.citedBy.total > 0, "a list page has in-links");
    console.log(`    List of countries: ${Math.round(100 * listy / list.citedBy.total)}% listy in-links of ${list.citedBy.total}`);
  }
  if (info.previous) {
    assert.ok(a.since && a.since.build === info.previous, "since carries the previous build");
    assert.ok(Array.isArray(a.since.gained) && Array.isArray(a.since.lost));
    assert.ok(a.since.gainedCount >= a.since.gained.length);
  } else {
    assert.equal(a.since, null);
  }

  const miss = await get("/api/article?title=Nope%20Nope%20Nope");
  assert.equal(miss.status, 404);
  assert.ok(miss.body.error);
});

test("article: since, on a known merge", { skip: !(FACTS && info.previous === "20260801") }, async () => {
  const r = await get("/api/article?title=Palestine");
  assert.equal(r.body.since.old, true);
  assert.ok(r.body.since.gainedCount >= 300, `Palestine gained ${r.body.since.gainedCount}`);
  const x = await get("/api/article?title=X%20(social%20platform)");
  assert.equal(x.body.since.old, false, "a new article");
});

// ---- random --------------------------------------------------------------------------
test("random", async () => {
  const r = await get(`/api/random?${HIDE}`);
  assert.equal(r.status, 200);
  assert.ok(Number.isInteger(r.body.idx) && typeof r.body.title === "string" && r.body.indeg >= 20);
});

// ---- views ---------------------------------------------------------------------------
test("view: neighborhood, all directions, hops, filters, within", async () => {
  const both = await get(`/api/view/neighborhood?title=Belgium&hops=2&limit=1000&${HIDE}`);
  if (!FACTS && both.status === 404) return;
  assert.equal(both.status, 200);
  checkView(both.body, { minNodes: 50 });
  assert.equal(both.body.pinned.length, 1, "the seed is pinned");
  assert.equal(both.body.nodes[Number(both.body.pinned[0])].label, "Belgium");
  assert.ok(both.body.nodes.some((n) => n.type === "1 hop away"), "hop types");
  assert.ok(both.body.nodes.length <= 1000, "limit");
  // Belgium fills a thousand at one hop; the second shell needs a quieter seed.
  const quiet = await get(`/api/view/neighborhood?title=Cheese&hops=2&limit=1000&${HIDE}`);
  if (FACTS) assert.ok(quiet.body.nodes.some((n) => n.type === "2 hops away"), "a second shell");

  const one = await get(`/api/view/neighborhood?title=Belgium&hops=1&limit=1000&${HIDE}`);
  assert.ok(one.body.nodes.length <= both.body.nodes.length, "no more at one hop");
  assert.ok(one.body.nodes.every((n) => n.type !== "2 hops away"));
  if (FACTS) {
    const quietOne = await get(`/api/view/neighborhood?title=Cheese&hops=1&limit=1000&${HIDE}`);
    assert.ok(quietOne.body.nodes.length < quiet.body.nodes.length, "fewer at one hop when the budget is not the limit");
  }

  const inn = await get(`/api/view/neighborhood?title=Belgium&hops=1&direction=in&limit=1000&${HIDE}`);
  const out = await get(`/api/view/neighborhood?title=Belgium&hops=1&direction=out&limit=1000&${HIDE}`);
  checkView(inn.body); checkView(out.body);
  assert.ok(/links to Belgium/.test(inn.body.vault) && /Belgium links to/.test(out.body.vault), "titles say the direction");

  const mutual = await get(`/api/view/neighborhood?title=Belgium&hops=1&mutual=1&limit=1000&${HIDE}`);
  checkView(mutual.body);
  assert.ok(mutual.body.nodes.length <= one.body.nodes.length, "mutual is a subset");
  assert.ok(mutual.body.edges.every((e) => e.d === 3), "mutual edges are both ways");
  // Both one-way orientations must survive: a link from a later position to an
  // earlier one was once dropped, and a neighbourhood has plenty of each.
  const ds = new Set(one.body.edges.map((e) => e.d));
  assert.ok(ds.has(1) && ds.has(2) && ds.has(3), `all three directions present: ${[...ds]}`);

  // filters reduce, and unfiltered includes lists
  const loose = await get("/api/view/neighborhood?title=Belgium&hops=1&limit=1000&hide=&minlen=0");
  assert.ok(loose.body.nodes.length >= one.body.nodes.length, "no filter is at least as many");
  if (FACTS) assert.ok(loose.body.nodes.some((n) => n.tags.includes("list")), "lists appear when not hidden");

  // within a category
  const within = await get(`/api/view/neighborhood?title=Belgium&hops=2&limit=1000&${HIDE}&within=Geography`);
  if (FACTS) {
    assert.equal(within.status, 200);
    checkView(within.body);
    assert.ok(within.body.within && within.body.within.articles > 0, "within block");
    assert.ok(within.body.nodes.length <= both.body.nodes.length, "within never widens");
    const quietWithin = await get(`/api/view/neighborhood?title=Cheese&hops=2&limit=1000&${HIDE}&within=Geography`);
    assert.ok(quietWithin.body.nodes.length < quiet.body.nodes.length, "within narrows when the budget is not the limit");
  }
  const badWithin = await get(`/api/view/neighborhood?title=Belgium&hops=1&limit=100&${HIDE}&within=No%20Such%20Category%20Xyz`);
  assert.equal(badWithin.status, 404);

  const miss = await get("/api/view/neighborhood?title=Nope%20Nope%20Nope");
  assert.equal(miss.status, 404);
});

test("view: lenses -- wedges by cluster and hops, dots by in-degree, PageRank ranking", async () => {
  const q = `title=Physics&hops=2&limit=800&${HIDE}`;
  const cluster = await get(`/api/view/neighborhood?${q}&group=cluster`);
  if (!FACTS && cluster.status === 404) return;
  checkView(cluster.body);
  const folders = new Set(cluster.body.nodes.map((n) => n.folder));
  assert.ok(folders.size >= 3, `clusters: ${folders.size}`);
  assert.ok([...folders].some((f) => f.includes(",")), "clusters named after members");

  const hops = await get(`/api/view/neighborhood?${q}&group=hops`);
  const hf = new Set(hops.body.nodes.map((n) => n.folder));
  assert.ok(hf.has("0 · the seed") && hf.has("1 hop away"), `hop wedges: ${[...hf]}`);

  const size = await get(`/api/view/neighborhood?${q}&size=indegree`);
  assert.ok(size.body.nodes.every((n) => typeof n.size === "number"), "size on every node");
  const biggest = size.body.nodes.reduce((a, b) => (b.size > a.size ? b : a));
  const most = size.body.nodes.reduce((a, b) => (b.indeg > a.indeg ? b : a));
  assert.equal(biggest.label, most.label, "largest dot is the most linked-to");

  const plain = await get(`/api/view/neighborhood?${q}`);
  assert.ok(plain.body.nodes.every((n) => n.size === undefined), "no size without a lens");

  if (info.pagerank) {
    const pr = await get(`/api/view/top?limit=50&${HIDE}&rank=pagerank`);
    assert.match(pr.body.vault, /PageRank/);
  }
});

test("view: path", async () => {
  const r = await get(`/api/view/path?from=Cheese&to=Black%20hole&limit=800&${HIDE}`);
  if (!FACTS && r.status === 404) return;
  assert.equal(r.status, 200);
  checkView(r.body);
  assert.ok(Array.isArray(r.body.pathTitles) && r.body.pathTitles.length >= 2);
  assert.equal(r.body.pathTitles[0], "Cheese");
  assert.equal(r.body.pathTitles.at(-1), "Black hole");
  assert.ok(r.body.pathTitles.length - 1 <= 8, "within eight hops");
  if (FACTS) assert.equal(r.body.pathTitles.length - 1, 3, "three hops on simplewiki");
  assert.equal(r.body.pinned.length, r.body.pathTitles.length, "every step pinned");
  const pinnedLabels = r.body.pinned.map((p) => r.body.nodes[Number(p)].label);
  assert.deepEqual(pinnedLabels, r.body.pathTitles);
  assert.ok(r.body.nodes.some((n) => /^step \d+ of \d+$/.test(n.type)));
  const miss = await get(`/api/view/path?from=Cheese&to=Nope%20Nope%20Nope`);
  assert.equal(miss.status, 404);
});

test("view: similar", async () => {
  const r = await get(`/api/view/similar?title=Belgium&limit=100&${HIDE}`);
  if (!FACTS && r.status === 404) return;
  assert.equal(r.status, 200);
  checkView(r.body, { minNodes: 20 });
  assert.equal(r.body.nodes[Number(r.body.pinned[0])].label, "Belgium", "the seed is pinned");
  assert.equal(r.body.nodes[0].type, "the seed");
  assert.ok(r.body.nodes.slice(1).every((n) => /^\d+% · shares \d+ links$/.test(n.type)), "scores as types");
  assert.equal(r.body.nodes[0].size, 1);
  assert.ok(r.body.nodes[1].size === 1 && r.body.nodes.at(-1).size <= r.body.nodes[1].size, "score as size, best first");
  assert.ok(r.body.similar.candidates > 100 && r.body.similar.ms < 2000, `candidates ${r.body.similar.candidates} in ${r.body.similar.ms} ms`);
  if (FACTS) {
    const top = r.body.nodes.slice(1, 8).map((n) => n.label);
    assert.ok(top.includes("Netherlands") && top.includes("Luxembourg"), `neighbours first: ${top}`);
    const e = await get(`/api/view/similar?title=Albert%20Einstein&limit=50&${HIDE}`);
    assert.ok(e.body.nodes.slice(1, 10).some((n) => /Bohr|Heisenberg|Lorentz|Penrose/.test(n.label)), "physicists for Einstein");
  }
  const miss = await get("/api/view/similar?title=Nope%20Nope%20Nope");
  assert.equal(miss.status, 404);
});

test("view: common ground", async () => {
  const r = await get(`/api/view/common?from=Belgium&to=Netherlands&limit=800&${HIDE}`);
  if (!FACTS && r.status === 404) return;
  assert.equal(r.status, 200);
  checkView(r.body, { minNodes: 3 });
  assert.equal(r.body.pinned.length, 2);
  assert.ok(r.body.common && r.body.common.cited + r.body.common.citing > 0);
  assert.ok(r.body.nodes.slice(0, 2).every((n) => n.type === "the seed"));
  const same = await get(`/api/view/common?from=Belgium&to=Belgium`);
  assert.equal(same.status, 400);
});

test("view: category, its parents, and within/and/not", async () => {
  const r = await get(`/api/view/category?title=German%20physicists&limit=800&depth=3&${HIDE}`);
  if (!FACTS && r.status === 404) return;
  assert.equal(r.status, 200);
  checkView(r.body);
  assert.match(r.body.vault, /^Category: /);
  assert.ok(r.body.category && Array.isArray(r.body.category.parents), "parents on the view");
  assert.ok(r.body.category.parents.length > 0, "a parent");
  const info2 = await get("/api/category?title=German%20physicists");
  assert.equal(info2.status, 200);
  assert.ok(info2.body.articles > 0 && Number.isInteger(info2.body.children));
  const firstOrg = info2.body.parents.findIndex((p) => p.organising);
  if (firstOrg >= 0) assert.ok(info2.body.parents.slice(firstOrg).every((p) => p.organising), "organising parents last");
  const shallow = await get(`/api/view/category?title=Physics&limit=3000&depth=1&${HIDE}`);
  const deep = await get(`/api/view/category?title=Physics&limit=3000&depth=3&${HIDE}`);
  assert.ok(shallow.body.nodes.length <= deep.body.nodes.length, "depth widens");
  // within A and B, within A not B: fewer than A alone, never more; not alone works
  const a = await get(`/api/view/top?limit=2000&${HIDE}&within=Geography`);
  const ab = await get(`/api/view/top?limit=2000&${HIDE}&within=Geography&and=Europe`);
  const anb = await get(`/api/view/top?limit=2000&${HIDE}&within=Geography&not=Europe`);
  assert.equal(ab.status, 200); assert.equal(anb.status, 200);
  assert.ok(ab.body.within.articles <= a.body.within.articles && anb.body.within.articles <= a.body.within.articles, "and/not narrow");
  assert.equal(ab.body.within.articles + anb.body.within.articles, a.body.within.articles, "and + not = all of A");
  assert.match(ab.body.within.name, /Geography and Europe/);
  assert.match(anb.body.within.name, /Geography minus Europe/);
  const onlyNot = await get(`/api/view/top?limit=50&${HIDE}&not=Geography`);
  assert.equal(onlyNot.status, 200);
  assert.match(onlyNot.body.within.name, /^everything minus Geography/);
  const badAnd = await get(`/api/view/top?limit=50&${HIDE}&within=Geography&and=No%20Such%20Category%20Xyz`);
  assert.equal(badAnd.status, 404);
  if (FACTS) assert.ok(r.body.nodes.some((n) => n.label === "Albert Einstein"), "Einstein is a German physicist");
  const miss = await get("/api/view/category?title=No%20Such%20Category%20Xyz");
  assert.equal(miss.status, 404);
});

test("view: top", async () => {
  const r = await get(`/api/view/top?limit=200&${HIDE}`);
  assert.equal(r.status, 200);
  checkView(r.body, { minNodes: 100 });
  assert.ok(r.body.nodes.length <= 200);
  const degs = r.body.nodes.map((n) => n.indeg);
  assert.ok(degs[0] >= degs.at(-1), "most linked-to first");
  if (FACTS) assert.equal(r.body.nodes[0].label, "United States");
  const over = await get(`/api/view/top?limit=999999&${HIDE}`);
  assert.ok(over.body.nodes.length <= info.maxNodes, "budget capped");
});

test("view: set (POST)", async () => {
  const titles = ["Belgium", "Netherlands", "Nope Nope Nope", "Belgium", "Luxembourg"];
  const r = await post(`/api/view/set?limit=100&${HIDE}`, { titles, title: "smoke", role: "step", pin: "Netherlands" });
  if (!FACTS && r.status === 404) return;
  assert.equal(r.status, 200);
  checkView(r.body);
  assert.equal(r.body.set.given, titles.length);
  assert.equal(r.body.set.unresolved, 1);
  assert.deepEqual(r.body.set.unknown, ["Nope Nope Nope"], "the unknown title is named");
  assert.equal(r.body.nodes.length, 3, "deduplicated and resolved");
  assert.equal(r.body.nodes[0].type, "step #1");
  assert.equal(r.body.nodes[0].size, 1, "first is the largest");
  assert.equal(r.body.nodes[Number(r.body.pinned[0])].label, "Netherlands", "pin honoured");
  const bad = await post(`/api/view/set`, { nope: 1 });
  assert.equal(bad.status, 400);
  const getNot = await get("/api/view/set");
  assert.equal(getNot.status, 405);
});

test("view: the new-links lens", { skip: !info.previous }, async () => {
  const r = await get(`/api/view/neighborhood?title=Ice%20hockey&hops=2&limit=1000&${HIDE}&since=1`);
  if (!FACTS && r.status === 404) return;
  checkView(r.body);
  assert.ok(r.body.since && r.body.since.build === info.previous);
  const fresh = r.body.edges.filter((e) => e.w === 2).length;
  assert.equal(fresh, r.body.since.newEdges, "count matches the marked edges");
  assert.ok(Array.isArray(r.body.since.newArticles) && Number.isInteger(r.body.since.newArticleCount), "new articles listed");
  assert.ok(r.body.since.newArticles.every((t) => r.body.nodes.some((n) => n.label === t)), "new articles are on the disc");
  if (FACTS) assert.ok(fresh > 0, "the new season shows");
});

test("view: a disambiguation seed offers choices", async () => {
  const r = await get(`/api/view/neighborhood?title=Mercury&hops=1&limit=200&${HIDE}`);
  if (!FACTS) return;
  assert.equal(r.status, 200);
  assert.ok(r.body.dab && r.body.dab.options.length >= 3, "dab block");
});

// ---- state --------------------------------------------------------------------------
test("state: get, put, version conflict, bad key", async () => {
  const put = async (key, body) => {
    const res = await fetch(`${base}/api/state/${key}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const key = `smoke-${process.pid % 1000}`;
  if (!info.state) {
    const off = await get(`/api/state/${key}`);
    assert.equal(off.status, 404, "no STATE_DIR: 404");
    return;
  }
  const empty = await get(`/api/state/${key}`);
  assert.deepEqual(empty.body, { version: 0, data: null });
  const w1 = await put(key, { version: 0, data: [{ title: "Brussels", state: "read" }] });
  assert.equal(w1.status, 200); assert.equal(w1.body.version, 1);
  const r1 = await get(`/api/state/${key}`);
  assert.equal(r1.body.version, 1); assert.deepEqual(r1.body.data, [{ title: "Brussels", state: "read" }]);
  const stale = await put(key, { version: 0, data: [] });
  assert.equal(stale.status, 409, "stale version refused");
  assert.equal(stale.body.version, 1, "the conflict carries the current record");
  const w2 = await put(key, { version: 1, data: [] });
  assert.equal(w2.status, 200); assert.equal(w2.body.version, 2);
  const bad = await put("No Such/Key", { version: 0, data: [] });
  assert.equal(bad.status, 400);
  const shape = await put(key, { nope: 1 });
  assert.equal(shape.status, 400);
  const notAllowed = await fetch(`${base}/api/state/${key}`, { method: "DELETE" });
  assert.equal(notAllowed.status, 405);
});

// ---- static --------------------------------------------------------------------------
test("static: the page, no-cache", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("cache-control") ?? "", /no-cache/);
  const html = await res.text();
  assert.ok(html.includes("vendor/page.js") && html.includes('id="mount"'), "the shell");
  const js = await fetch(`${base}/vendor/page.js`);
  assert.equal(js.status, 200);
  const nope = await fetch(`${base}/no/such/file`);
  assert.equal(nope.status, 404);
  const escape = await fetch(`${base}/../api/server.mjs`);
  assert.notEqual(escape.status, 200, "no path escape");
});

// ---- the compare script --------------------------------------------------------------
// The monthly report, when two builds and a Python with numpy are at hand. The
// ingest's own venv on a dev machine; python3 with numpy elsewhere; skipped otherwise.
test("compare.py on the two builds", { skip: !info.previous }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { readdirSync, realpathSync } = await import("node:fs");
  const root = GRAPH_DIR.endsWith("/current") || readdirSync(GRAPH_DIR).some((d) => /^\d{8}$/.test(d)) ? GRAPH_DIR : dirname(GRAPH_DIR);
  const cur = existsSync(join(root, "current")) ? realpathSync(join(root, "current")) : root;
  const prev = join(root, info.previous);
  const py = [join(ROOT, ".venv/bin/python"), "python3"].find((x) => x === "python3" || existsSync(x));
  let out;
  try {
    out = execFileSync(py, [join(ROOT, "ingest/compare.py"), "--wiki", WIKI, prev, cur, "--out", "/dev/null"],
                       { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  } catch (e) {
    if (/No module named numpy|not found/.test(String(e.stderr ?? e.message))) return; // no numpy here: not this test's business
    throw e;
  }
  assert.match(out, new RegExp(`^${WIKI}: ${info.previous} -> `), "header names both builds");
  assert.match(out, /articles\s+[\d,]+\s+->\s+[\d,]+/, "article counts");
  assert.match(out, /top 40 by in-degree/);
  assert.match(out, /arrived \(/);
  if (FACTS && info.previous === "20260801") assert.match(out, /X \(social platform\)/, "the rename shows");
});

test.after(() => stop());
