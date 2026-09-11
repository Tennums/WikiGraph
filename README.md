# Wikigraph

[vault-graph](https://github.com/luke321/vault-graph)'s disc, pointed at a local copy of
Wikipedia instead of an Obsidian vault. Every article is a dot; every subject area owns a
wedge of the circle; best-connected articles sit near the centre.

The interface is upstream's, in `web/vendor/`, with its vocabulary changed from Obsidian's
to Wikipedia's and nothing else touched. Everything else here exists to hand it the object
it expects.

---

## Why it is built this way

**The renderer re-plans its entire layout on every animated frame.** That is what makes
the motion continuous rather than interpolated, and it is deliberate — but upstream's own
issue tracker records a 10,000-node vault animating at 14 fps. English Wikipedia has
~7 million articles and ~1.6 billion links.

So the graph is never handed to the browser. It is queried, and every view returns a few
thousand articles chosen for a reason:

| View | Selection | Wedges |
|---|---|---|
| **Around an article** | breadth-first from a seed, best-connected first | subject area |
| **Category tree** | everything under a category, N levels deep | direct subcategories |
| **Best connected** | the top articles by degree | subject area |

Degree is recomputed over each selection rather than taken globally: the disc rings
articles by the links it can actually see, and a global degree would pull articles to the
centre for links to nodes that are not on screen.

## Architecture

```
SQL dumps ──► ingest/build.py ──► <wiki>.csr  ─┐
                                  <wiki>.db   ─┴─► api/server.mjs ──► web/ (the disc)
                                                          │
ZIM file  ──► kiwix-serve ◄───────────────────────────────┘  "read the article"
```

Two sources, each doing what it is good at. The **SQL dumps** already contain the exact
link graph — no parsing of article text, no guessing. **Kiwix** serves readable articles
from a single ZIM file with its own full-text search. Extracting a link graph from a ZIM
means parsing every article's HTML; serving readable prose from SQL dumps means importing
all of MediaWiki. Neither is necessary when you run both.

### The graph file

A CSR (compressed sparse row) binary: a header, one 64-bit offset per article, then the
neighbour lists end to end. Neighbours of article `i` are `targets[offsets[i]:offsets[i+1]]`
— one seek, no index, no query planner.

The API reads it with positioned reads rather than loading it. enwiki's target array runs
to several GB, past what a single Node `Buffer` can hold, and the OS page cache already
does the caching a hand-rolled loader would. Only the offset array stays resident: 56 MB
at enwiki scale.

---

## Running it

All state lives on the NAS under `DATA_DIR`; the containers hold nothing of their own.

```
/media/vault/WikiGraph/
├── dumps/     enwiki-latest-*.sql.gz     (input, mounted read-only)
├── graph/     enwiki.csr, enwiki.db      (built once, then read-only)
└── zim/       <ZIM_BOOK>.zim              (Kiwix)
```

```bash
cp .env.example .env          # set WIKI, ZIM_BOOK, KIWIX_URL
docker compose --profile ingest run --rm ingest
docker compose up -d
```

The ingest needs ~15 GB of **local** scratch (`SCRATCH_DIR`, a named volume by default).
It must not point at the NAS: SQLite coordinates through POSIX advisory locks that
network filesystems do not reliably provide, so building the database on the share fails
with `database is locked` on a file nothing else has open — and it fails at the very end,
after the expensive half has already succeeded. The database is built locally and moved
across when it is finished.

If a run dies after the CSR is written, `--meta-only` reuses it and rebuilds only the
database, skipping the pagelinks pass — over half the total run:

```bash
docker compose --profile ingest run --rm ingest --wiki enwiki --meta-only
```

It refuses if the CSR is missing or its article count disagrees with the page dump, and
checks both before reading a dump rather than half an hour in.

`./ingest` is bind-mounted over the copy in the image, so edits to the ingest take effect
on the next run with no rebuild. **The API is not** — it is a service, and its image is
meant to be immutable — so after changing anything under `api/` or `web/`:

```bash
docker compose up -d --build api
```

`docker compose run` and `up` both reuse an existing image without rebuilding. An
unrecognised flag in a usage message is the tell: the container is running older code
than the working tree.

If you still need the dumps, `./fetch-dumps.sh enwiki /media/vault/WikiGraph/dumps`
fetches all six. It downloads **sequentially on purpose** — `dumps.wikimedia.org` answers
parallel requests from one address with 429, and a 429 lands as a 169-byte HTML error page
wearing a `.sql.gz` name, which then fails deep inside the parser instead of at the
download. Each file is verified with `gzip -t` before it counts as fetched.

### Behind Caddy

LAN only, one hostname, two services split by path:

```caddyfile
wikigraph.docker.home.arpa {
    import internal_tls

    handle /kiwix* {
        reverse_proxy wikigraph-kiwix:8080
    }

    handle {
        reverse_proxy wikigraph:3000
    }
}
```

`handle`, **not** `handle_path`. `kiwix-serve` is started with `-r /kiwix`, so it knows
its own prefix and writes every link and asset as `/kiwix/…`; it therefore expects that
prefix on the way in too. `handle_path` strips it, and Kiwix's own absolute URLs then
break on the first click.

Both web-facing services join the external `proxy` network and carry an explicit
`container_name`, because on a shared network the compose alias is just `api` — which any
other stack on that network can also claim. Nothing is published on the host: the `ports:`
lines are commented out, to be re-enabled only to bypass the proxy while debugging.

The ingest runs with `network_mode: none` — it serves nothing and only moves files between
two NAS directories.

Two settings have to agree, and there is nothing to catch it if they drift: `KIWIX_URL`
(what the API writes into article links) and `kiwix-serve -r` (what Kiwix answers on). Both
say `/kiwix` out of the box.

### The reading layer

Fetch a ZIM from [the Kiwix library](https://download.kiwix.org/zim/wikipedia/), set
`ZIM_BOOK` to its name, and start the profile:

```bash
./fetch-zim.sh wikipedia_en_all_maxi_2026-08 /media/vault/WikiGraph/zim
docker compose --profile kiwix up -d
```

The script resumes an interrupted download (`curl -C -`, with retries) and checks the
published SHA-256 when it finishes. Both matter at 119 GB: a dropped connection should
cost nothing, and a truncated ZIM does not fail loudly — `kiwix-serve` opens it and some
articles just come back wrong. Kiwix also publishes `.torrent` and `.magnet` files beside
each ZIM and recommends them for files this size; if you go that way, the checksum is at
`<name>.zim.sha256` on the same server.

The profile matters: a plain `up -d` does not start Kiwix, and Caddy answers every
"read the article" click with a 502 until it is running.

`ZIM_BOOK` does double duty. The compose file hands `/zim/<ZIM_BOOK>.zim` straight to
`kiwix-serve` — no `library.xml`, no `kiwix-manage` step — and the API builds article
links as `<KIWIX_URL>/content/<ZIM_BOOK>/<Article_Title>`. Kiwix derives the book name
from the filename (lowercased, no extension), so the two agree by construction; the
filenames from the Kiwix library are already lowercase.

`docker compose logs kiwix` is the first place to look when articles fail: the image's
start script prints the directory listing when `kiwix-serve` cannot open its file.

| ZIM | Size |
|---|---|
| `wikipedia_en_all_maxi` | 119 GB |
| `wikipedia_en_all_nopic` | 49 GB |
| `wikipedia_en_all_mini` | 12 GB (intros only) |
| `wikipedia_nl_all_nopic` | 5.4 GB |

---

## Scale

Measured, simplewiki, on a laptop:

| | |
|---|---|
| Dumps | 193 MB |
| Build | 33 s |
| Articles / links | 284,808 / 12,953,854 |
| `.csr` / `.db` | 52 MB / 119 MB |
| Query (2,500 nodes) | 60–150 ms |
| Draw (5,565 nodes) | 588 ms |

Measured, enwiki, on the target server:

| | |
|---|---|
| Build | 118 min |
| Articles | 7,235,024 (+12.0M redirects, 2.6M categories) |
| Links | 1,661,633,402 rows → 731,419,915 in-article → 712,208,796 unique |
| `.csr` | 2.91 GB |
| Categories | 102.2M memberships, 10.1M subcategory edges |
| Topics | 33 under `Main_topic_classifications`, placing 83% of articles |

Where the time goes: pagelinks 53 min, categorylinks 25 min, linktarget 20 min, page
9 min, page_props 4 min. It is a single-threaded stream — it wants RAM and a fast local
scratch disk, not cores.

---

## Known limits

**The timeline says "last edited", not "created".** The `page` table carries only
`page_touched`. Real creation dates need the `stub-meta-history` dump, which is far larger
than everything here combined. Until then the date ribbon shows when articles were last
touched, which clusters heavily in recent months.

**Wedges come from a walk down the wiki's own subject roots.** Raw categories were tried
first and do not work — they are a fine-grained overlapping mesh rather than a hierarchy,
so the commonest ones across a selection left two thirds of articles in none of them, and
maintenance categories ("Webarchive template wayback links", "Unprintworthy redirects")
took the rest. The build instead walks down from `Main_topic_classifications` (enwiki) or
`Articles` (simplewiki) and gives each article its nearest subject. That places 94% of
simplewiki; maintenance categories are simply unreachable from a subject root, so they
disappear without a blocklist.

**Lists and year pages dominate by degree.** simplewiki's most-linked articles are
`List_of_municipalities_in_Switzerland` and `Deaths_in_2024`. The "best connected" view is
mostly geography stubs as a result. A stub filter (`--min-len`) exists; a list filter does
not yet.

**Schema note for anyone extending this.** Since MediaWiki 1.41 both `pagelinks` and
`categorylinks` reference a separate `linktarget` table instead of storing titles inline —
there is no `pl_title` and no `cl_to` any more. Most tutorials online predate this.

---

## Layout

```
ingest/dumpparse.py   streaming readers, one regex per table
ingest/build.py       dumps -> CSR + SQLite
api/graph.mjs         CSR reader, selections, VAULT_DATA assembly
api/server.mjs        HTTP; no npm dependencies (node:http + node:sqlite)
web/index.html        the shell: view picker, search, Kiwix wiring
web/vendor/           vault-graph v2.3.0, vocabulary adapted — see UPSTREAM.md
```

`web/vendor/` began as a verbatim copy of upstream's `src/` (commit `afcc942` here) and
has since diverged in exactly two ways: the user-facing strings say *article*, *topic* and
*wiki* instead of *note*, *folder* and *vault*, and the detail card's open button takes its
URL from a `deps.articleHref` callback rather than a hardcoded `obsidian://` link. Layout,
rendering and interaction code are untouched. `web/vendor/UPSTREAM.md` records the upstream
commit and how to carry our changes onto a newer release with `git apply --3way`.

## Licence

[vault-graph](https://github.com/luke321/vault-graph) is MIT (Lukas Proprentner); its
renderer is a port of [Sigma.js](https://www.sigmajs.org/) 3.0.2, also MIT. Both notices
are kept in `web/vendor/`. Wikipedia content is CC BY-SA.
