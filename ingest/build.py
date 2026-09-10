#!/usr/bin/env python3
"""Turn MediaWiki SQL dumps into the two artifacts the API serves.

    data/graph/<wiki>.csr      the link graph, memory-mappable
    data/graph/<wiki>.db       SQLite metadata: titles, sizes, categories

This is the file that replaces vault-graph's `build-graph.mjs`. Same job -- crawl a
corpus, resolve its links, emit nodes and edges -- against a corpus four orders of
magnitude larger, which is what dictates every choice below.

Why arrays and not dictionaries
-------------------------------
enwiki has ~7M articles, ~10M redirects and a `linktarget` table of a few hundred
million rows. A Python dict mapping link-target ids to articles would want well over
10 GB of RAM for the small integers alone. Both id spaces are dense auto-increments,
so a flat numpy array indexed by the id costs 4 bytes per slot and answers in one
load. Only `title -> page_id` genuinely needs a hash, and only while `linktarget` is
being read; it is dropped immediately afterwards.

Why a counting sort and not a sort
----------------------------------
CSR wants edges grouped by source. Sorting a billion pairs needs roughly twice the
array in RAM. Counting each source's degree first turns the same job into a prefix sum
plus one scattered write per edge -- linear, and it needs only the target array.

Redirects are resolved here, once
---------------------------------
Roughly a third of enwiki's links point at a redirect. Left alone they show up as
millions of degree-1 stubs and the disc turns to fluff, so every link is followed to
the article it really means before it ever reaches the graph.
"""

from __future__ import annotations

import argparse
import array
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import dumpparse as dp  # noqa: E402

NS_ARTICLE, NS_CATEGORY = 0, 14
# A redirect pointing at a redirect is legal and rare; MediaWiki itself refuses to
# follow more than one hop, but resolving a few recovers real links for free.
MAX_REDIRECT_HOPS = 3

log_t0 = time.time()


def log(msg: str) -> None:
    print(f"[{time.time() - log_t0:7.1f}s] {msg}", flush=True)


def dump(wiki: str, table: str, d: Path) -> str:
    """Locate one dump, or fail with enough detail to fix it in one go.

    The usual cause of a miss is a dated filename: the dumps are also published as
    `<wiki>-20260901-<table>.sql.gz`, and only the `latest/` directory uses the name
    this expects. So the error lists what is actually there -- a naming mismatch is
    obvious at a glance, where a bare "not found" sends you looking for a missing
    download that is sitting right next to it.
    """
    p = d / f"{wiki}-latest-{table}.sql.gz"
    if p.exists():
        return str(p)

    # Accept a dated dump if exactly one matches: it is the same file, and refusing it
    # over its name helps nobody.
    dated = sorted(d.glob(f"{wiki}-*-{table}.sql.gz"))
    if len(dated) == 1:
        log(f"  using {dated[0].name}")
        return str(dated[0])
    if len(dated) > 1:
        sys.exit(f"several dumps match {wiki}-*-{table}.sql.gz:\n  " +
                 "\n  ".join(x.name for x in dated) +
                 f"\n  keep one, or rename it to {p.name}")

    have = sorted(x.name for x in d.glob("*.sql.gz")) if d.is_dir() else []
    sys.exit(
        f"missing dump: {p}\n"
        f"  fetch it from https://dumps.wikimedia.org/{wiki}/latest/\n"
        + (f"  {d} holds: " + ", ".join(have) if have
           else f"  {d} holds no .sql.gz files at all")
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--wiki", default="simplewiki", help="e.g. simplewiki, enwiki")
    ap.add_argument("--dumps", default="data/dumps", type=Path)
    ap.add_argument("--out", default="data/graph", type=Path)
    ap.add_argument("--topic-root", default="",
                    help="category whose children become the wedges "
                         "(default: Main_topic_classifications, then Articles)")
    ap.add_argument("--topic-depth", type=int, default=6,
                    help="how far below a topic a category may sit and still count")
    ap.add_argument("--min-len", type=int, default=0,
                    help="drop articles shorter than this many bytes (stub filter)")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------------- 1. pages
    # One pass over `page` gives every id space we need. Redirects are kept: links
    # point at them and have to land somewhere before being followed.
    log("reading page ...")
    art_pid, art_title, art_len, art_touched = [], [], array.array("i"), []
    cat_pid, cat_title = [], []
    redirect_flags: list[int] = []     # page ids that are redirects
    title2pid: dict[str, int] = {}     # ns0 titles only
    cat_title2pid: dict[str, int] = {}
    max_pid = 0

    for pid, ns, title, is_redirect, touched, length in dp.pages(dump(args.wiki, "page", args.dumps)):
        max_pid = max(max_pid, pid)
        if ns == NS_ARTICLE:
            title2pid[title] = pid
            if is_redirect:
                redirect_flags.append(pid)
            elif length >= args.min_len:
                art_pid.append(pid)
                art_title.append(title)
                art_len.append(length)
                art_touched.append(touched)
        elif ns == NS_CATEGORY:
            cat_title2pid[title] = pid
            if not is_redirect:
                cat_pid.append(pid)
                cat_title.append(title)

    n = len(art_pid)
    log(f"  {n:,} articles, {len(redirect_flags):,} redirects, {len(cat_pid):,} categories")

    # Dense 0..n-1 index over real articles -- the node ids the CSR and the UI use.
    pid2idx = np.full(max_pid + 1, -1, dtype=np.int32)
    pid2idx[np.array(art_pid, dtype=np.int64)] = np.arange(n, dtype=np.int32)

    # --------------------------------------------------------------- 2. redirects
    log("reading redirect ...")
    # pid -> pid, one hop, then chased below.
    hop = np.full(max_pid + 1, -1, dtype=np.int32)
    for rd_from, ns, title in dp.redirects(dump(args.wiki, "redirect", args.dumps)):
        if ns != NS_ARTICLE or rd_from > max_pid:
            continue
        tgt = title2pid.get(title)
        if tgt is not None:
            hop[rd_from] = tgt

    # Fold the chain into pid2idx so a link to a redirect resolves in a single lookup.
    chased = 0
    for src in redirect_flags:
        if src > max_pid:
            continue
        cur = src
        for _ in range(MAX_REDIRECT_HOPS):
            nxt = hop[cur]
            if nxt < 0:
                break
            cur = int(nxt)
            if pid2idx[cur] >= 0:
                pid2idx[src] = pid2idx[cur]
                chased += 1
                break
    del hop
    log(f"  {chased:,} redirects resolved to articles")

    # ------------------------------------------------------------- 3. linktarget
    # lt_id -> node index, with redirects already folded in. This is the map that
    # would have cost >10 GB as a dict; as an array it is 4 bytes per lt_id.
    log("reading linktarget ...")
    lt_path = dump(args.wiki, "linktarget", args.dumps)
    max_lt = 0
    for lt_id, ns, title in dp.linktargets(lt_path):
        if lt_id > max_lt:
            max_lt = lt_id
    lt2idx = np.full(max_lt + 1, -1, dtype=np.int32)
    lt2cat = np.full(max_lt + 1, -1, dtype=np.int32)   # category targets, for step 6
    for lt_id, ns, title in dp.linktargets(lt_path):
        if ns == NS_ARTICLE:
            pid = title2pid.get(title)
            if pid is not None:
                lt2idx[lt_id] = pid2idx[pid]
        elif ns == NS_CATEGORY:
            pid = cat_title2pid.get(title)
            if pid is not None:
                lt2cat[lt_id] = pid
    del title2pid
    log(f"  {int((lt2idx >= 0).sum()):,} link targets resolve to articles")

    # -------------------------------------------------------------- 4. pagelinks
    # Two passes. The first resolves every link and banks the pairs in a scratch file
    # while counting each source's degree; the second places them. Reading the scratch
    # file back is far cheaper than decompressing the dump twice.
    log("reading pagelinks ...")
    deg = np.zeros(n + 1, dtype=np.int64)
    scratch = args.out / f"{args.wiki}.edges.tmp"
    kept = seen = 0
    with open(scratch, "wb") as fh:
        buf = array.array("i")
        for pl_from, from_ns, lt_id in dp.pagelinks(dump(args.wiki, "pagelinks", args.dumps)):
            seen += 1
            if from_ns != NS_ARTICLE or pl_from > max_pid or lt_id > max_lt:
                continue
            s = pid2idx[pl_from]
            t = lt2idx[lt_id]
            # A link from or to a non-article, and an article's link to itself (which
            # a redirect collapse can easily create), carry no structure.
            if s < 0 or t < 0 or s == t:
                continue
            buf.append(int(s)); buf.append(int(t))
            deg[s] += 1
            kept += 1
            if len(buf) >= 1 << 22:
                buf.tofile(fh); buf = array.array("i")
        buf.tofile(fh)
    log(f"  {seen:,} rows -> {kept:,} article links")
    del lt2idx

    # Prefix sum gives each source its slice of the target array.
    offsets = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(deg[:n], out=offsets[1:])
    targets = np.empty(kept, dtype=np.int32)
    cursor = offsets[:n].copy()

    log("building CSR ...")
    with open(scratch, "rb") as fh:
        while True:
            block = np.fromfile(fh, dtype=np.int32, count=1 << 22)
            if block.size == 0:
                break
            src, dst = block[0::2], block[1::2]
            # A source usually appears many times inside one block, so its slot has to
            # advance *within* the block too -- reading the cursor once per edge would
            # hand every link from one article the same slot. Grouping the block by
            # source makes that rank a counted offset from each group's start.
            order = np.argsort(src, kind="stable")
            s_sorted = src[order]
            starts = np.r_[0, np.flatnonzero(np.diff(s_sorted)) + 1]
            group_len = np.diff(np.r_[starts, s_sorted.size])
            rank = np.arange(s_sorted.size) - np.repeat(starts, group_len)
            targets[cursor[s_sorted] + rank] = dst[order]
            cursor += np.bincount(src, minlength=n)
    os.unlink(scratch)

    # Redirect collapsing can make two links from one article point at the same
    # target. Sorting each slice makes the duplicates adjacent, and a sorted slice is
    # what lets the API intersect neighbour lists cheaply later.
    log("deduplicating ...")
    out_off = np.zeros(n + 1, dtype=np.int64)
    write = 0
    for i in range(n):
        a, b = offsets[i], offsets[i + 1]
        if b > a:
            uniq = np.unique(targets[a:b])
            targets[write:write + uniq.size] = uniq
            write += uniq.size
        out_off[i + 1] = write
    targets = targets[:write]
    offsets = out_off
    log(f"  {write:,} unique links ({kept - write:,} duplicates removed)")

    # ----------------------------------------------------------- 5. write the CSR
    csr = args.out / f"{args.wiki}.csr"
    with open(csr, "wb") as fh:
        # A tiny header so the API can validate what it mapped instead of trusting
        # the filename.
        np.array([0x57474B31, 1, n, write], dtype=np.int64).tofile(fh)  # "WGK1"
        offsets.astype(np.int64).tofile(fh)
        targets.astype(np.int32).tofile(fh)
    log(f"wrote {csr} ({csr.stat().st_size / 1e9:.2f} GB)")

    # ------------------------------------------------------------ 6. categories
    log("reading categorylinks ...")
    # Flat arrays, not lists of tuples: enwiki has ~100M memberships, and a Python
    # tuple costs ~80 bytes against the 8 an int32 pair costs here.
    ac_idx, ac_cat = array.array("i"), array.array("i")
    cp_child, cp_parent = array.array("i"), array.array("i")
    for cl_from, kind, lt_id in dp.categorylinks(dump(args.wiki, "categorylinks", args.dumps)):
        if cl_from > max_lt and cl_from > max_pid:
            continue
        parent = lt2cat[lt_id] if lt_id <= max_lt else -1
        if parent < 0:
            continue
        if kind == "page" and cl_from <= max_pid:
            idx = pid2idx[cl_from]
            if idx >= 0:
                ac_idx.append(int(idx)); ac_cat.append(int(parent))
        elif kind == "subcat":
            cp_child.append(cl_from); cp_parent.append(int(parent))
    log(f"  {len(ac_idx):,} memberships, {len(cp_child):,} subcategory edges")

    # Hidden categories. Wikipedia files most articles in a dozen maintenance
    # categories -- "Articles with hCards", "Webarchive template wayback links" -- and
    # they outnumber the topical ones badly enough to take every wedge if left in.
    # MediaWiki flags them with the `hiddencat` page property; title-prefix guessing
    # gets most of them and wrongly condemns real topics, so we read the flag.
    log("reading page_props ...")
    hidden = {pid for pid, name, _ in
              dp.pageprops(dump(args.wiki, "page_props", args.dumps))
              if name == "hiddencat"}
    log(f"  {len(hidden):,} hidden categories")

    # --------------------------------------------------------------- 7. topics
    #
    # The wedge problem. vault-graph gives every top-level folder a wedge, and a vault
    # has perhaps a dozen. Wikipedia's categories are nothing like folders: they are a
    # fine-grained overlapping mesh, so "Jupiter's moons" and "Basic English 850 words"
    # come out as peers and no article shares a category with most of its neighbours.
    #
    # What does behave like a folder is the handful of subject areas the wiki files
    # everything under. Walking down from those and giving each category its nearest
    # one turns the mesh back into something with a top level. Two useful side effects:
    # maintenance categories are simply not reachable from a subject root, so they
    # disappear without needing a blocklist, and the depth cap stops the walk before
    # the category graph's cycles make everything a descendant of everything.
    children: dict[int, list[int]] = {}
    for child, parent in zip(cp_child, cp_parent):
        children.setdefault(parent, []).append(child)

    title_of = dict(zip(cat_pid, cat_title))
    root = -1
    for cand in ([args.topic_root] if args.topic_root else
                 ["Main_topic_classifications", "Articles", "Contents"]):
        pid = cat_title2pid.get(cand.replace(" ", "_"))
        if pid is not None and children.get(pid):
            root, root_title = pid, cand
            break
    if root < 0:
        log("WARNING: no topic root found -- wedges will fall back to raw categories")
        topic_of_cat = {}
    else:
        roots = [c for c in children[root] if c not in hidden]
        log(f"topics: {len(roots)} under {root_title} "
            f"({', '.join(title_of.get(c, '?') for c in roots[:8])}...)")
        # Multi-source BFS: whichever topic reaches a category first owns it, so a
        # category filed under two subjects goes to the nearer one and ties break on
        # the order the roots are listed -- deterministic either way.
        topic_of_cat: dict[int, int] = {}
        frontier = [(c, c) for c in roots]
        for _ in range(args.topic_depth):
            nxt = []
            for cat, topic in frontier:
                if cat in topic_of_cat:
                    continue
                topic_of_cat[cat] = topic
                for ch in children.get(cat, ()):
                    if ch not in topic_of_cat:
                        nxt.append((ch, topic))
            if not nxt:
                break
            frontier = nxt
        log(f"  {len(topic_of_cat):,} of {len(cat_pid):,} categories reach a topic")

    # An article takes the topic of its first topical category. `art_cats` preserves
    # the order categories appear on the page, and that order is editorial: the most
    # specific and most relevant category is conventionally listed first.
    topic_name = [""] * n
    for idx, cat in zip(ac_idx, ac_cat):
        if not topic_name[idx]:
            t = topic_of_cat.get(cat)
            if t is not None:
                topic_name[idx] = title_of.get(t, "")
    placed = sum(1 for t in topic_name if t)
    log(f"  {placed:,} of {n:,} articles placed in a topic "
        f"({100 * placed / max(n, 1):.0f}%)")

    # --------------------------------------------------------------- 8. metadata
    db = args.out / f"{args.wiki}.db"
    if db.exists():
        os.unlink(db)
    log(f"writing {db} ...")
    con = sqlite3.connect(db)
    con.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous  = OFF;
        CREATE TABLE node     (idx INTEGER PRIMARY KEY, title TEXT NOT NULL,
                               len INTEGER, touched TEXT, deg INTEGER, topic TEXT);
        CREATE TABLE category (pid INTEGER PRIMARY KEY, title TEXT NOT NULL,
                               hidden INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE node_cat (idx INTEGER, cat INTEGER);
        CREATE TABLE cat_tree (child INTEGER, parent INTEGER);
        CREATE TABLE meta     (k TEXT PRIMARY KEY, v TEXT);
    """)
    degrees = np.diff(offsets)
    con.executemany("INSERT INTO node VALUES (?,?,?,?,?,?)",
                    ((i, art_title[i], art_len[i], art_touched[i], int(degrees[i]),
                      topic_name[i]) for i in range(n)))
    con.executemany("INSERT INTO category VALUES (?,?,?)",
                    ((p, t, 1 if p in hidden else 0)
                     for p, t in zip(cat_pid, cat_title)))
    con.executemany("INSERT INTO node_cat VALUES (?,?)", zip(ac_idx, ac_cat))
    con.executemany("INSERT INTO cat_tree VALUES (?,?)", zip(cp_child, cp_parent))
    con.executemany("INSERT INTO meta VALUES (?,?)", [
        ("wiki", args.wiki), ("nodes", str(n)), ("edges", str(write)),
        ("built", time.strftime("%Y-%m-%d %H:%M")),
    ])
    log("indexing ...")
    con.executescript("""
        CREATE INDEX i_node_title ON node(title);
        CREATE INDEX i_node_deg   ON node(deg DESC);
        CREATE INDEX i_nc_idx     ON node_cat(idx);
        CREATE INDEX i_nc_cat     ON node_cat(cat);
        CREATE INDEX i_ct_parent  ON cat_tree(parent);
        CREATE INDEX i_ct_child   ON cat_tree(child);
        CREATE INDEX i_cat_title  ON category(title);
        CREATE INDEX i_cat_hidden ON category(hidden);
        CREATE INDEX i_node_topic ON node(topic);
    """)
    con.commit()
    con.close()
    log(f"done: {n:,} nodes, {write:,} edges, {db.stat().st_size / 1e6:.0f} MB metadata")


if __name__ == "__main__":
    main()
