"""
What changed between two builds of the same wiki.

    python compare.py --wiki enwiki /data/graph/current /data/graph/20260901

Prints a report and writes it beside the new build as <wiki>.changes.txt. The monthly
refresh runs it before swapping builds, so the answer to "what did this month's dumps
change" is on the terminal and on disk, not something to reconstruct later.

Articles are matched by title, not by index: the CSR index is a build's own numbering
and shifts with every article inserted before it. A renamed article therefore shows up
as one that left and one that arrived, which is the truth of it as far as links go --
every link to the old title now points at a redirect.

In-degree comes straight from the reverse CSR's offsets; titles from the SQLite node
table. For enwiki that is two seven-million-entry dictionaries and a minute or two;
the ingest just spent two hours, so this is not where to economise on clarity.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from build import HEADER, KIND_NAMES  # noqa: E402

TOP, GAINS, LOSSES, ARRIVED, LEFT = 40, 25, 10, 15, 10


def load(d: Path, wiki: str) -> dict:
    """One build: titles (by index), in-degree, kind, and the meta table."""
    rcsr = d / f"{wiki}.rcsr"
    db = d / f"{wiki}.db"
    for p in (rcsr, db):
        if not p.exists():
            sys.exit(f"compare: no {p}")
    head = np.fromfile(rcsr, dtype=np.int64, count=4)
    n, m = int(head[2]), int(head[3])
    indeg = np.diff(np.fromfile(rcsr, dtype=np.int64, count=n + 1, offset=HEADER)).astype(np.int64)
    kind_path = d / f"{wiki}.kind"
    kind = (np.fromfile(kind_path, dtype=np.uint8, offset=HEADER, count=n)
            if kind_path.exists() else np.zeros(n, dtype=np.uint8))
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    titles = [None] * n
    for idx, title in con.execute("SELECT idx, title FROM node"):
        titles[idx] = title
    meta = dict(con.execute("SELECT k, v FROM meta"))
    con.close()
    # The dump run the build came from: refresh.sh leaves a BUILD marker, and names the
    # directory after it; a flat build has neither and is named by when it was built.
    marker = d / "BUILD"
    name = (marker.read_text().strip() if marker.exists()
            else d.name if re.fullmatch(r"\d{8}", d.name)
            else f"built {meta.get('built', '?')}")
    return {"n": n, "m": m, "indeg": indeg, "kind": kind, "titles": titles, "meta": meta,
            "dir": d, "name": name}


def fmt(n: int) -> str:
    return f"{n:,}"


def delta(a: int, b: int) -> str:
    d = b - a
    return f"{'+' if d >= 0 else ''}{d:,}"


def label(t: str) -> str:
    return t.replace("_", " ")


def report(wiki: str, old: dict, new: dict) -> list[str]:
    out = []
    w = out.append
    w(f"{wiki}: {old['name']} -> {new['name']}")
    w(f"  {old['dir']}")
    w(f"  {new['dir']}")
    w("")
    row = lambda name, a, b: w(f"  {name:<18}{fmt(a):>12}  ->  {fmt(b):>12}   {delta(a, b)}")
    row("articles", old["n"], new["n"])
    row("links", old["m"], new["m"])
    ok = np.bincount(old["kind"], minlength=5)
    nk = np.bincount(new["kind"], minlength=5)
    for k in range(1, 5):
        row(f"  {KIND_NAMES[k]}", int(ok[k]), int(nk[k]))

    # title -> (in-degree, rank) for the old build; rank only matters for the top list
    old_deg = {t: int(d) for t, d in zip(old["titles"], old["indeg"])}
    old_order = np.argsort(-old["indeg"], kind="stable")
    old_rank = {old["titles"][i]: r + 1 for r, i in enumerate(old_order[:TOP * 5])}
    new_order = np.argsort(-new["indeg"], kind="stable")

    w("")
    w(f"top {TOP} by in-degree")
    top_new = set()
    for r, i in enumerate(new_order[:TOP]):
        t = new["titles"][i]
        top_new.add(t)
        d = int(new["indeg"][i])
        was = old_rank.get(t)
        move = ("  new" if t not in old_deg else "  --" if was is None or was > TOP
                else "" if was == r + 1 else f"  {'^' if was > r + 1 else 'v'} was #{was}")
        w(f"  {r + 1:>3}. {label(t):<45} {fmt(d):>10}  {delta(old_deg.get(t, 0), d):>9}{move}")
    left_top = [t for t, r in old_rank.items() if r <= TOP and t not in top_new]
    if left_top:
        w("  left the top " + str(TOP) + ": " + ", ".join(label(t) for t in left_top))

    # gains and losses over the articles both builds have
    both_idx = [i for i, t in enumerate(new["titles"]) if t in old_deg]
    both = np.fromiter(both_idx, dtype=np.int64, count=len(both_idx))
    d_new = new["indeg"][both]
    d_old = np.fromiter((old_deg[new["titles"][i]] for i in both_idx), dtype=np.int64, count=len(both_idx))
    diff = d_new - d_old
    w("")
    w(f"biggest gains in in-degree ({fmt(len(both_idx))} articles in both builds)")
    for j in np.argsort(-diff, kind="stable")[:GAINS]:
        if diff[j] <= 0:
            break
        i = both[j]
        w(f"  {label(new['titles'][i]):<45} {fmt(int(d_old[j])):>10} -> {fmt(int(d_new[j])):>10}  {delta(int(d_old[j]), int(d_new[j])):>9}"
          + (f"  [{KIND_NAMES[new['kind'][i]]}]" if new["kind"][i] else ""))
    w("")
    w("biggest losses")
    for j in np.argsort(diff, kind="stable")[:LOSSES]:
        if diff[j] >= 0:
            break
        i = both[j]
        w(f"  {label(new['titles'][i]):<45} {fmt(int(d_old[j])):>10} -> {fmt(int(d_new[j])):>10}  {delta(int(d_old[j]), int(d_new[j])):>9}")

    # arrivals and departures: by title, so a rename is one of each
    new_titles = set(new["titles"])
    arrived = [i for i in new_order if new["titles"][i] not in old_deg]
    w("")
    w(f"arrived ({fmt(len(arrived))} titles not in the previous build; most linked-to)")
    for i in arrived[:ARRIVED]:
        w(f"  {label(new['titles'][i]):<45} {fmt(int(new['indeg'][i])):>10}"
          + (f"  [{KIND_NAMES[new['kind'][i]]}]" if new["kind"][i] else ""))
    gone = [i for i in old_order if old["titles"][i] not in new_titles]
    w("")
    w(f"left ({fmt(len(gone))} titles no longer present; most linked-to)")
    for i in gone[:LEFT]:
        w(f"  {label(old['titles'][i]):<45} {fmt(int(old['indeg'][i])):>10}")
    return out


def write_growth(wiki: str, old: dict, new: dict, new_dir: Path, top: int = 5000) -> Path:
    """The per-article in-degree gains, old build -> new, for the API's "fastest growing".

    Matched by title like the report; arrivals count from zero. Only the top few
    thousand gains are kept -- the tail is noise and the file is read on every request.
    Written beside the build it describes, named for the pair.
    """
    old_deg = {t: int(d) for t, d in zip(old["titles"], old["indeg"])}
    rows = []
    for i, t in enumerate(new["titles"]):
        d_new = int(new["indeg"][i])
        d_old = old_deg.get(t, 0)
        if d_new > d_old:
            rows.append((d_new - d_old, t, d_old, d_new))
    rows.sort(reverse=True)
    out = {"wiki": wiki, "previous": old["name"], "build": new["name"],
           "top": [[t, d_old, d_new] for _, t, d_old, d_new in rows[:top]]}
    path = new_dir / f"{wiki}.growth.json"
    path.write_text(json.dumps(out), encoding="utf-8")
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--wiki", default="simplewiki")
    ap.add_argument("old", type=Path, help="directory of the build in use")
    ap.add_argument("new", type=Path, help="directory of the build just made")
    ap.add_argument("--out", type=Path, default=None,
                    help="where to write the report (default: <new>/<wiki>.changes.txt)")
    ap.add_argument("--no-growth", action="store_true",
                    help="do not write <new>/<wiki>.growth.json (the per-article gains the API serves)")
    args = ap.parse_args()
    t0 = time.time()
    old = load(args.old.resolve(), args.wiki)
    new = load(args.new.resolve(), args.wiki)
    lines = report(args.wiki, old, new)
    text = "\n".join(lines) + "\n"
    sys.stdout.write(text)
    out = args.out or (args.new / f"{args.wiki}.changes.txt")
    out.write_text(text, encoding="utf-8")
    if not args.no_growth:
        gpath = write_growth(args.wiki, old, new, args.new.resolve())
        print(f"growth written to {gpath}", file=sys.stderr)
    print(f"\nwritten to {out}  ({time.time() - t0:.0f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
