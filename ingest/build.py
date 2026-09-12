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

Why the SQLite file is built on local disk and moved afterwards
--------------------------------------------------------------
SQLite coordinates through POSIX advisory locks, which network filesystems implement
partially (NFS) or not usefully (SMB/CIFS). Creating the database straight onto a NAS
mount fails with "database is locked" on a brand-new file with no other process in
sight. The CSR is unaffected because plain sequential writes need no locking -- which
is exactly why the failure lands two hours in, after the expensive half has succeeded.
Building locally is also far quicker: enwiki inserts ~100M category rows and builds
nine indexes, and doing that over a network mount is glacial even where it works.
"""

from __future__ import annotations

import argparse
import array
import os
import shutil
import sqlite3
import sys
import tempfile
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


MAGIC = 0x57474B31  # "WGK1"
HEADER = 32         # 4 x int64: magic, version, n, m


def write_reverse(csr: Path, rcsr: Path) -> None:
    """Derive the in-link CSR from the out-link one.

    The forward file already is the complete edge list, so the transpose never touches a
    dump: it is what lets the reverse graph be added to an existing build in minutes.

    Same counting-sort placement as the forward build, in blocks, and for the same
    reason -- an argsort over enwiki's 712M edges wants ~6 GB of int64 indices on top of
    the arrays themselves, where this needs the output array and a cursor. Walking the
    forward CSR visits sources in increasing order, so each target's sources arrive
    sorted and the result has the same sorted-unique property as the forward file.
    """
    head = np.fromfile(csr, dtype=np.int64, count=4)
    if int(head[0]) != MAGIC:
        sys.exit(f"{csr} is not a wikigraph CSR (bad magic)")
    n, m = int(head[2]), int(head[3])
    offsets = np.fromfile(csr, dtype=np.int64, count=n + 1, offset=HEADER)
    # Memory-mapped: enwiki's targets are 2.9 GB and are read once, sequentially.
    targets = np.memmap(csr, dtype=np.int32, mode="r",
                        offset=HEADER + 8 * (n + 1), shape=(m,))

    log(f"transposing {csr.name}: {n:,} articles, {m:,} links ...")
    indeg = np.bincount(targets, minlength=n).astype(np.int64)
    roff = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(indeg, out=roff[1:])
    rtargets = np.empty(m, dtype=np.int32)
    cursor = roff[:n].copy()

    outdeg = np.diff(offsets)
    block = 1 << 22
    for a in range(0, m, block):
        b = min(a + block, m)
        dst = np.asarray(targets[a:b])
        # Which source each edge in [a, b) belongs to: the article whose slice spans it.
        src = (np.searchsorted(offsets, np.arange(a, b), side="right") - 1).astype(np.int32)
        order = np.argsort(dst, kind="stable")
        d_sorted = dst[order]
        starts = np.r_[0, np.flatnonzero(np.diff(d_sorted)) + 1]
        group_len = np.diff(np.r_[starts, d_sorted.size])
        rank = np.arange(d_sorted.size) - np.repeat(starts, group_len)
        rtargets[cursor[d_sorted] + rank] = src[order]
        cursor += np.bincount(dst, minlength=n)
    del outdeg

    with open(rcsr, "wb") as fh:
        np.array([MAGIC, 1, n, m], dtype=np.int64).tofile(fh)
        roff.tofile(fh)
        rtargets.tofile(fh)
    log(f"wrote {rcsr} ({rcsr.stat().st_size / 1e9:.2f} GB); "
        f"max in-degree {int(indeg.max()):,}")


def write_pagerank(csr: Path, out: Path, wiki: str, damping: float = 0.85,
                   iterations: int = 30) -> np.ndarray:
    """PageRank by power iteration over the forward CSR, written as <wiki>.rank.

    In-degree counts links; PageRank weighs each by the rank of the page it comes from
    and the number of links that page spreads it over. The two mostly agree at the top
    and disagree in the middle, which is where a view spends its budget.

    One pass per iteration over the edge list in blocks: for a block of edges the
    source of each is recovered from the offsets (the article whose slice spans it),
    and a bincount over the targets accumulates r[src] / outdeg[src]. Dangling pages --
    no out-links -- hand their rank to everyone, as the standard formulation has it.
    enwiki: ~712M edges, a few seconds per iteration, minutes in all.
    """
    head = np.fromfile(csr, dtype=np.int64, count=4)
    n, m = int(head[2]), int(head[3])
    offsets = np.fromfile(csr, dtype=np.int64, count=n + 1, offset=HEADER)
    targets = np.memmap(csr, dtype=np.int32, mode="r", offset=HEADER + 8 * (n + 1), shape=(m,))
    outdeg = np.diff(offsets).astype(np.float64)
    dangling = outdeg == 0
    inv_out = np.where(dangling, 0.0, 1.0 / np.maximum(outdeg, 1))

    log(f"pagerank over {n:,} articles, {m:,} links: {iterations} iterations ...")
    r = np.full(n, 1.0 / n)
    block = 1 << 22
    for it in range(iterations):
        w = r * inv_out                      # what each page sends down each link
        acc = np.zeros(n)
        for a in range(0, m, block):
            b = min(a + block, m)
            src = np.searchsorted(offsets, np.arange(a, b), side="right") - 1
            acc += np.bincount(np.asarray(targets[a:b]), weights=w[src], minlength=n)
        leaked = r[dangling].sum()           # dangling mass, spread evenly
        r_new = (1 - damping) / n + damping * (acc + leaked / n)
        delta = np.abs(r_new - r).sum()
        r = r_new
        if delta < 1e-9:
            log(f"  converged after {it + 1} iterations (delta {delta:.2e})")
            break
    path = out / f"{wiki}.rank"
    with open(path, "wb") as fh:
        np.array([MAGIC, 1, n, 0], dtype=np.int64).tofile(fh)
        r.astype(np.float32).tofile(fh)
    log(f"wrote {path} ({path.stat().st_size / 1e6:.0f} MB)")
    return r


import re

# Node kinds, one byte per article in <wiki>.kind. The API hides kinds on request; the
# ingest only labels. 0 is the default and never needs writing.
KIND_ARTICLE, KIND_LIST, KIND_DATE, KIND_DAB, KIND_INFRA = 0, 1, 2, 3, 4
KIND_NAMES = {KIND_ARTICLE: "article", KIND_LIST: "list", KIND_DATE: "date",
              KIND_DAB: "disambiguation", KIND_INFRA: "infrastructure"}

# A list page is a list by title on every Wikipedia; this is the convention, not a
# heuristic. Timeline_of_ is arguably a date page but behaves like a list.
RE_LIST = re.compile(
    r"^(Lists?|Index|Outline|Timeline|Glossary|Bibliography|Discography|Filmography|"
    r"Comparison)_of_")
# Bare years and decades, centuries, calendar days, deaths-in and year-in-topic pages.
# Anchored at both ends so "1984 (novel)" and "2024 Summer Olympics" stay articles.
RE_DATE = re.compile(
    r"^(\d{1,4}(_BC)?|\d{3,4}s|\d{1,2}(st|nd|rd|th)_(century|millennium)(_BC)?|"
    r"(January|February|March|April|May|June|July|August|September|October|November|"
    r"December)_\d{1,2}|Deaths_in_(\w+_)?\d{4}|\d{4}_in_.+)$")
RE_DAB_TITLE = re.compile(r"_\(disambiguation\)$")
# Categories that organise rather than describe -- stub bins, "X by country" containers,
# template and list holders, project bookkeeping. Walked through, never used as a
# topic label. Mirrors ORGANISING_CAT in api/graph.mjs; keep the two in step.
RE_ORGANISING_CAT = re.compile(
    r"(_stubs?|_templates|-related_lists|_by_[a-z_]+|_redirects)$"
    r"|^(Wikipedia|WikiProject|Redirects|Stubs?)_|_articles(_|$)")


def classify(titles, dab_idx, infra_titles):
    """One kind byte per article, from title shape, the disambiguation flag, and the
    infrastructure list. Order matters only where two rules match; infrastructure is
    checked first because it is the deliberate one."""
    kind = np.zeros(len(titles), dtype=np.uint8)
    for i, t in enumerate(titles):
        if t in infra_titles:
            kind[i] = KIND_INFRA
        elif i in dab_idx or RE_DAB_TITLE.search(t):
            kind[i] = KIND_DAB
        elif RE_LIST.match(t):
            kind[i] = KIND_LIST
        elif RE_DATE.match(t):
            kind[i] = KIND_DATE
    return kind


def write_kinds(out: Path, wiki: str, titles, dab_idx: set, indeg=None) -> None:
    infra_path = Path(__file__).parent / "infrastructure.txt"
    infra = set()
    if infra_path.exists():
        for line in infra_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                infra.add(line)
    kind = classify(titles, dab_idx, infra)
    n = len(titles)
    path = out / f"{wiki}.kind"
    with open(path, "wb") as fh:
        np.array([MAGIC, 1, n, 0], dtype=np.int64).tofile(fh)
        kind.tofile(fh)
    counts = np.bincount(kind, minlength=5)
    log(f"wrote {path}: " + ", ".join(f"{counts[k]:,} {KIND_NAMES[k]}" for k in range(1, 5)))

    # The list of infrastructure pages is curated, and this is where it grows from:
    # whatever sits in the top 40 by in-degree and is still labelled "article" is the
    # next candidate. Printed, not decided -- United States belongs there too.
    if indeg is not None:
        log("top 40 by in-degree, with kind (unlabelled hubs may belong in infrastructure.txt):")
        for i in np.argsort(-indeg)[:40]:
            tag = KIND_NAMES[int(kind[i])]
            log(f"  {int(indeg[i]):8,}  {tag:14}  {titles[i]}")


def write_redirect_aliases(out: Path, wiki: str, pairs) -> None:
    """<wiki>.redirects.tsv.gz: one `title<TAB>idx` line per redirect that lands on an
    article. Small (enwiki: ~80 MB), and the only thing the search index needs from
    the redirect table."""
    import gzip
    path = out / f"{wiki}.redirects.tsv.gz"
    count = 0
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        for title, idx in pairs:
            fh.write(f"{title}\t{idx}\n")
            count += 1
    log(f"wrote {path} ({count:,} redirect aliases)")


def read_redirect_aliases(out: Path, wiki: str):
    """The sidecar's pairs as a list, or None when there is no sidecar.

    Not a generator: a function with `yield` in it hands back a generator object no
    matter what, so a `return None` inside it can never signal a missing file --
    which is exactly how the first version of this silently indexed no aliases."""
    import gzip
    path = out / f"{wiki}.redirects.tsv.gz"
    if not path.exists():
        return None
    pairs = []
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            t, i = line.rstrip("\n").split("\t")
            pairs.append((t, int(i)))
    return pairs


def derive_redirect_aliases(args, titles) -> list:
    """For a build made before the sidecar existed: the same mapping from the page and
    redirect dumps plus the database's own titles. ~10 minutes on enwiki, once; the
    result is written as the sidecar so it is never needed again."""
    title2idx = {t: i for i, t in enumerate(titles)}
    log("reading page (redirect titles) ...")
    redir_title: dict[int, str] = {}
    for pid, ns, title, is_redirect, _, _ in dp.pages(dump(args.wiki, "page", args.dumps)):
        if ns == NS_ARTICLE and is_redirect:
            redir_title[pid] = title
    log(f"  {len(redir_title):,} redirects")
    log("reading redirect (targets) ...")
    target: dict[int, str] = {}
    for rd_from, ns, title in dp.redirects(dump(args.wiki, "redirect", args.dumps)):
        if ns == NS_ARTICLE and rd_from in redir_title:
            target[rd_from] = title
    # Follow a chain of redirects the way the graph build does, a few hops at most.
    rtitle2pid = {t: pid for pid, t in redir_title.items()}
    pairs = []
    for pid, title in redir_title.items():
        t = target.get(pid)
        for _ in range(MAX_REDIRECT_HOPS):
            if t is None:
                break
            idx = title2idx.get(t)
            if idx is not None:
                pairs.append((title, idx))
                break
            t = target.get(rtitle2pid.get(t, -1))
    write_redirect_aliases(args.out, args.wiki, pairs)
    return pairs


def write_search_index(out: Path, wiki: str, tmp: Path, titles, indeg, aliases=None) -> None:
    """A separate FTS5 database over titles, ranked by in-degree.

    Separate, because the main database lives on a NAS and is never written after the
    build; this one is built locally and moved, like the main one was. Titles are stored
    with spaces so the tokenizer splits words, and with diacritics folded so "Zurich"
    finds "Zürich". In-degree rides along as a column: bm25 rank is meaningless for a
    title index, and what a user wants first is the article the wiki points at most.
    """
    staged = tmp / f"{wiki}.search.db.building"
    for stale in (staged, Path(str(staged) + "-journal")):
        stale.unlink(missing_ok=True)
    con = sqlite3.connect(staged)
    con.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous  = OFF;
        CREATE VIRTUAL TABLE titles USING fts5(
            title, idx UNINDEXED, indeg UNINDEXED, alias UNINDEXED,
            tokenize = 'unicode61 remove_diacritics 2'
        );
    """)
    con.executemany("INSERT INTO titles (title, idx, indeg, alias) VALUES (?, ?, ?, 0)",
                    ((t.replace("_", " "), i, int(indeg[i])) for i, t in enumerate(titles)))
    # Redirect titles as aliases: same target idx and in-degree, flagged so the API can
    # fold them onto the article and say which name matched.
    n_alias = 0
    if aliases:
        def rows():
            nonlocal n_alias
            for t, i in aliases:
                n_alias += 1
                yield (t.replace("_", " "), i, int(indeg[i]))
        con.executemany("INSERT INTO titles (title, idx, indeg, alias) VALUES (?, ?, ?, 1)", rows())
    con.execute("INSERT INTO titles(titles) VALUES ('optimize')")
    con.commit()
    con.close()
    dest = out / f"{wiki}.search.db"
    dest.unlink(missing_ok=True)
    shutil.move(str(staged), str(dest))
    log(f"wrote {dest} ({dest.stat().st_size / 1e6:.0f} MB, {len(titles):,} titles"
        + (f" + {n_alias:,} redirect aliases" if n_alias else "") + ")")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--wiki", default="simplewiki", help="e.g. simplewiki, enwiki")
    ap.add_argument("--dumps", default="data/dumps", type=Path)
    ap.add_argument("--out", default="data/graph", type=Path)
    ap.add_argument("--tmpdir", default=os.environ.get("WIKIGRAPH_TMPDIR") or None,
                    type=Path,
                    help="local scratch for the edge file and the SQLite build "
                         "(default: system temp). Must NOT be on a network mount.")
    ap.add_argument("--meta-only", action="store_true",
                    help="reuse the existing .csr and rebuild only the .db -- skips "
                         "the pagelinks pass, which is over half the run")
    ap.add_argument("--reverse-only", action="store_true",
                    help="derive the in-link .rcsr from an existing .csr and stop; "
                         "reads no dumps, touches no database")
    ap.add_argument("--rank-only", action="store_true",
                    help="compute PageRank from an existing .csr into <wiki>.rank and "
                         "stop; reads no dumps")
    ap.add_argument("--index-only", action="store_true",
                    help="build the title search index <wiki>.search.db for an "
                         "existing build; reads only the existing .db and .rcsr")
    ap.add_argument("--classify-only", action="store_true",
                    help="write <wiki>.kind (list / date / disambiguation / "
                         "infrastructure) for an existing build; reads the page and "
                         "page_props dumps and the existing .db, writes nothing else")
    ap.add_argument("--topic-root", default="",
                    help="category whose children become the wedges "
                         "(default: Main_topic_classifications, then Articles)")
    ap.add_argument("--topic-depth", type=int, default=6,
                    help="how far below a topic a category may sit and still count")
    ap.add_argument("--min-len", type=int, default=0,
                    help="drop articles shorter than this many bytes (stub filter)")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    tmp = args.tmpdir or Path(tempfile.gettempdir())
    if tmp.exists() and not tmp.is_dir():
        sys.exit(f"--tmpdir {tmp} exists but is not a directory")
    tmp.mkdir(parents=True, exist_ok=True)

    if args.reverse_only:
        csr = args.out / f"{args.wiki}.csr"
        if not csr.exists():
            sys.exit(f"--reverse-only needs an existing {csr}")
        write_reverse(csr, args.out / f"{args.wiki}.rcsr")
        return

    if args.rank_only:
        csr = args.out / f"{args.wiki}.csr"
        if not csr.exists():
            sys.exit(f"--rank-only needs an existing {csr}")
        r = write_pagerank(csr, args.out, args.wiki)
        # Side by side with in-degree, so the two rankings can be compared at a glance.
        db = args.out / f"{args.wiki}.db"
        rcsr = args.out / f"{args.wiki}.rcsr"
        if db.exists() and rcsr.exists():
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            title = dict(con.execute("SELECT idx, title FROM node"))
            con.close()
            hn = int(np.fromfile(rcsr, dtype=np.int64, count=4)[2])
            indeg = np.diff(np.fromfile(rcsr, dtype=np.int64, count=hn + 1, offset=HEADER))
            top_r, top_i = np.argsort(-r)[:20], np.argsort(-indeg)[:20]
            log("top 20 by PageRank                       | top 20 by in-degree")
            for x, y in zip(top_r, top_i):
                log(f"  {title[int(x)][:38]:38} | {title[int(y)][:38]}")
        return

    if args.index_only:
        db = args.out / f"{args.wiki}.db"
        rcsr = args.out / f"{args.wiki}.rcsr"
        for need in (db, rcsr):
            if not need.exists():
                sys.exit(f"--index-only needs an existing {need}")
        log("reading titles from the database ...")
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        titles = [t for _, t in con.execute("SELECT idx, title FROM node ORDER BY idx")]
        con.close()
        hn = int(np.fromfile(rcsr, dtype=np.int64, count=4)[2])
        if hn != len(titles):
            sys.exit(f"{rcsr} holds {hn:,} articles, the database {len(titles):,}")
        indeg = np.diff(np.fromfile(rcsr, dtype=np.int64, count=hn + 1, offset=HEADER))
        aliases = read_redirect_aliases(args.out, args.wiki)
        if aliases is None:
            log("no redirect sidecar yet -- deriving it from the page and redirect dumps")
            aliases = derive_redirect_aliases(args, titles)
        write_search_index(args.out, args.wiki, tmp, titles, indeg, aliases)
        return

    if args.classify_only:
        # Titles come from the existing database (read-only, which a NAS mount is fine
        # with). The disambiguation flag lives in page_props keyed by page id, and the
        # database does not keep page ids, so the page dump is read once to map them.
        db = args.out / f"{args.wiki}.db"
        if not db.exists():
            sys.exit(f"--classify-only needs an existing {db}")
        log("reading titles from the database ...")
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        rows = con.execute("SELECT idx, title FROM node ORDER BY idx").fetchall()
        con.close()
        titles = [t for _, t in rows]
        title2idx = {t: i for i, t in rows}
        log(f"  {len(titles):,} articles")
        log("reading page (for page ids) ...")
        pid2idx_map = {}
        for pid, ns, title, is_redirect, _, _ in dp.pages(dump(args.wiki, "page", args.dumps)):
            if ns == NS_ARTICLE and not is_redirect:
                i = title2idx.get(title)
                if i is not None:
                    pid2idx_map[pid] = i
        del title2idx
        log("reading page_props (for the disambiguation flag) ...")
        dab = {pid2idx_map[pid] for pid, name, _ in
               dp.pageprops(dump(args.wiki, "page_props", args.dumps))
               if name == "disambiguation" and pid in pid2idx_map}
        rcsr = args.out / f"{args.wiki}.rcsr"
        indeg = None
        if rcsr.exists():
            hn = int(np.fromfile(rcsr, dtype=np.int64, count=4)[2])
            indeg = np.diff(np.fromfile(rcsr, dtype=np.int64, count=hn + 1, offset=HEADER))
        write_kinds(args.out, args.wiki, titles, dab, indeg)
        return

    free = shutil.disk_usage(tmp).free
    log(f"scratch: {tmp} ({free / 1e9:.0f} GB free)")
    # enwiki wants ~6 GB for the edge file and ~8 GB for the database. Checking now
    # rather than discovering it at minute 90 is the difference between a two-second
    # failure and a two-hour one.
    if free < 5e9:
        sys.exit(f"only {free / 1e9:.1f} GB free on {tmp}; pass --tmpdir somewhere "
                 f"with room (enwiki needs ~15 GB of scratch)")
    if free < 25e9:
        log(f"  WARNING: enwiki wants ~15 GB here; {free / 1e9:.0f} GB may be tight")

    # Validate --meta-only's input before reading a single dump. The article-count
    # check needs `n` and so has to wait, but a missing or corrupt CSR can be caught
    # now -- otherwise enwiki spends half an hour parsing linktarget only to find
    # there was nothing to reuse.
    if args.meta_only:
        probe = args.out / f"{args.wiki}.csr"
        if not probe.exists():
            sys.exit(f"--meta-only needs an existing {probe}")
        if int(np.fromfile(probe, dtype=np.int64, count=1)[0]) != 0x57474B31:
            sys.exit(f"{probe} is not a wikigraph CSR (bad magic)")
        log(f"  --meta-only: will reuse {probe}")

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
    is_redirect = np.zeros(max_pid + 1, dtype=bool)
    is_redirect[np.array(redirect_flags, dtype=np.int64)] = True

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

    # Redirect titles are how people name things -- "USA", "NYC", "Einstein" -- and the
    # search index wants them as aliases of their targets. They are banked now, while
    # title2pid still exists, as a small gzipped sidecar the index step can read back
    # without touching a dump.
    write_redirect_aliases(args.out, args.wiki,
                           ((t, int(pid2idx[pid])) for t, pid in title2pid.items()
                            if is_redirect[pid] and pid2idx[pid] >= 0))

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
    csr = args.out / f"{args.wiki}.csr"

    if args.meta_only:
        # The CSR is the expensive half and it is already on disk. Read back just the
        # header and offsets: everything downstream needs `offsets` (for per-article
        # degree) and the edge count, nothing else.
        if not csr.exists():
            sys.exit(f"--meta-only needs an existing {csr}")
        head = np.fromfile(csr, dtype=np.int64, count=4)
        if int(head[0]) != 0x57474B31:
            sys.exit(f"{csr} is not a wikigraph CSR (bad magic)")
        csr_n, write = int(head[2]), int(head[3])
        if csr_n != n:
            sys.exit(f"{csr} holds {csr_n:,} articles but the page dump gives "
                     f"{n:,} -- the dumps changed, so rebuild without --meta-only")
        offsets = np.fromfile(csr, dtype=np.int64, count=n + 1, offset=32)
        log(f"reusing {csr}: {n:,} articles, {write:,} links")
    else:
        deg = np.zeros(n + 1, dtype=np.int64)
        # Local, not next to the output: this file is written once and read back once,
        # and pushing ~6 GB across a network mount twice is pure waste.
        scratch = tmp / f"{args.wiki}.edges.tmp"
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
        with open(csr, "wb") as fh:
            # A tiny header so the API can validate what it mapped instead of trusting
            # the filename.
            np.array([MAGIC, 1, n, write], dtype=np.int64).tofile(fh)
            offsets.astype(np.int64).tofile(fh)
            targets.astype(np.int32).tofile(fh)
        log(f"wrote {csr} ({csr.stat().st_size / 1e9:.2f} GB)")

    # A fresh forward build always gets a fresh reverse; a reused one only if the
    # reverse is missing, so --meta-only on an older build fills the gap once.
    rcsr = args.out / f"{args.wiki}.rcsr"
    if not args.meta_only or not rcsr.exists():
        write_reverse(csr, rcsr)

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
    hidden, dab_idx = set(), set()
    for pid, name, _ in dp.pageprops(dump(args.wiki, "page_props", args.dumps)):
        if name == "hiddencat":
            hidden.add(pid)
        elif name == "disambiguation" and pid <= max_pid and pid2idx[pid] >= 0:
            dab_idx.add(int(pid2idx[pid]))
    log(f"  {len(hidden):,} hidden categories, {len(dab_idx):,} disambiguation pages")

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
        # A topic is a direct child of the root that describes a subject. Hidden and
        # organising categories are skipped: simplewiki files "Wikipedia articles by
        # source" and "Good articles" beside Science and Geography, and neither is a
        # wedge anyone wants.
        roots = [c for c in children[root]
                 if c not in hidden and not RE_ORGANISING_CAT.search(title_of.get(c, ""))]
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
    staged = tmp / f"{args.wiki}.db.building"

    # Build locally, move at the end. SQLite needs POSIX advisory locks that network
    # filesystems do not reliably provide, so creating this straight on the NAS fails
    # with "database is locked" on a file nothing else has open. Sidecars go too: a
    # journal left by a crashed run is read back as state and locks the new database.
    for stale in (staged, Path(str(staged) + "-journal"), Path(str(staged) + "-wal"),
                  Path(str(staged) + "-shm")):
        stale.unlink(missing_ok=True)
    log(f"writing {staged} ...")
    con = sqlite3.connect(staged)
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

    # shutil.move falls back to copy+delete across filesystems, which is what this is.
    # The destination is removed first: overwriting in place would leave a half-written
    # database readable by a running API if the copy is interrupted.
    log(f"moving {staged.stat().st_size / 1e9:.2f} GB to {db} ...")
    db.unlink(missing_ok=True)
    shutil.move(str(staged), str(db))
    log(f"done: {n:,} nodes, {write:,} edges, {db.stat().st_size / 1e6:.0f} MB metadata")

    rn = int(np.fromfile(rcsr, dtype=np.int64, count=4)[2])
    indeg = np.diff(np.fromfile(rcsr, dtype=np.int64, count=rn + 1, offset=HEADER))
    write_kinds(args.out, args.wiki, art_title, dab_idx, indeg)
    write_search_index(args.out, args.wiki, tmp, art_title, indeg,
                       read_redirect_aliases(args.out, args.wiki) or [])
    write_pagerank(csr, args.out, args.wiki)


if __name__ == "__main__":
    main()
