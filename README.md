# Wikigraph

[vault-graph](https://github.com/luke321/vault-graph)'s disc, pointed at a local copy of
Wikipedia instead of an Obsidian vault. Every article is a dot; every subject area owns a
wedge of the circle; best-connected articles sit near the centre.

The interface is upstream's, unmodified, in `web/vendor/`. Everything else here exists to
hand it the object it expects.

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

Needs Docker, and dumps for the wiki you want.

```bash
cp .env.example .env          # set WIKI, and ZIM_BOOK if you have a ZIM
./fetch-dumps.sh simplewiki   # ~190 MB; enwiki is ~14 GB
docker compose --profile ingest run --rm ingest
docker compose up -d
```

Then open <http://localhost:3000>.

Fetching is **sequential on purpose** — `dumps.wikimedia.org` answers parallel requests
from one address with 429, and a 429 lands as a 169-byte HTML error page wearing a
`.sql.gz` name, which then fails deep inside the parser instead of at the download.

### Adding the reading layer

Download a ZIM from [the Kiwix library](https://download.kiwix.org/zim/wikipedia/) into
`data/zim/`, set `ZIM_BOOK` to its filename without the extension, and start the profile:

```bash
docker compose --profile kiwix up -d
```

`KIWIX_URL` must be reachable **by the browser**, so use the server's LAN address rather
than a compose service name.

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

Projected for enwiki from those rates — **not yet measured**:

| | |
|---|---|
| Dumps | ~14 GB |
| Build | 1–2 hours |
| Articles / links | ~7M / ~0.9–1B |
| `.csr` / `.db` | ~4 GB / ~5–8 GB |
| Peak RAM during ingest | ~12–16 GB |

The ingest is a single-threaded stream; it wants RAM and a scratch disk, not cores. Give
it 32 GB to be comfortable.

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
web/vendor/           vault-graph, verbatim — do not edit
```

`web/vendor/` is upstream's `src/`, unmodified, so it can be re-vendored from a new
release without replaying a patch. The one place Obsidian leaks into the render layer is a
hardcoded `obsidian://open` href on the detail card; `web/index.html` rewrites that anchor
after the card draws rather than patching the file.

## Licence

[vault-graph](https://github.com/luke321/vault-graph) is MIT (Lukas Proprentner); its
renderer is a port of [Sigma.js](https://www.sigmajs.org/) 3.0.2, also MIT. Both notices
are kept in `web/vendor/`. Wikipedia content is CC BY-SA.
