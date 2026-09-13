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
| **Around an article** | breadth-first along links in both directions, most linked-to first | subject area |
| **What links here** | the same, following in-links only | subject area |
| **What it links to** | the same, following out-links only | subject area |
| **Path between two** | the shortest chain of links, pinned to the hub, each step with a slice of its neighbourhood | subject area |
| **Common ground of two** | what both link to, and who links to both — the overlap rather than the chain; both seeds pinned | subject area |
| **Category tree** | everything under a category, N levels deep | direct subcategories |
| **Most linked-to** | the top articles by in-degree | subject area |
| **Reading order for** | *experimental* — what an article assumes, from lead paragraphs: its own lead links, and what two or more of those articles' leads share; drawn as a disc with the article pinned, listed as an order under the bar | subject area |
| **Articles that mention** | every article whose *text* contains the words, from the ZIM's own full-text index, in Kiwix's ranking; the first hit is the largest dot | subject area |

**Read the article beside the disc.** The card's *Read the article* opens a panel on the
right — an iframe onto Kiwix, same origin, so the frame is ours to read — with the disc
still live on the left. Links inside the article navigate the panel; *Draw around this* in
the panel's bar recenters the disc on what you are reading; ← is the panel's own history.
The two histories are kept apart on purpose: an iframe shares the window's session history,
so a naive "back" in the panel undid the last disc move instead. Every navigation in the
frame uses `location.replace()` and the panel keeps its own stack, so the browser's back
button is the disc's alone. The divider drags; the width is remembered. Under 900px the
panel overlays rather than squeezes. Middle-click or ↗ still opens a tab.

**The detail card shows the article's first paragraph and its lead image.** Kiwix sits
behind the same hostname, so the page fetches the article itself — same origin, no proxy —
and takes the first real paragraph out of mwoffliner's HTML: past the hatnotes, past the
infobox. The image is the infobox's first photograph, or failing that its first large
drawing (a country's locator map), and only then a thumbnail from the body; mwoffliner tags
every image `bitmap` or `drawing`, which is what keeps a flag or a signature from being
chosen. Cached per title for the session; a fetch is abandoned the moment the selection
moves on. Images need a *maxi* ZIM; with a *nopic* one the card has the paragraph alone,
and with no ZIM at all it has neither, as it has no read button.

**Surprise me** picks a random article that passes the current filters and is linked to at
least twenty times — a starting point with somewhere to go — and draws around it. With
*Draw around this* on the card, that is an aimless walk through the wiki; the back button
retraces it.

**Export CSV / JSON** in the sidebar writes what is on the disc — hidden topics, hidden
subgroups and the date range all leave an article out, exactly as they do on screen. CSV
comes as `nodes.csv` (title, wedge, type, kind, links on disc, words, last edited) and
`edges.csv` (source title, target title), ready for Gephi or a spreadsheet; JSON is the
same in one file. The edge list is taken from the data the API sent, not from the
renderer's store, which past a few thousand links keeps only a share of them for drawing.

**Six degrees** is a game made of parts that already exist: two random well-linked
articles at least three hops apart, a walk from one to the other with *Draw around this*,
and at the end the route set against the shortest path. The disc's own search is pointed
at the target while you play, so it lights up the moment it is within reach — seeing it is
fair; finding the way there is the game. *Give up* shows the shortest route instead.

What a view is about sits in the hub — upstream's "pin to hub", applied by the API: the
article a neighbourhood is drawn around, every step of a path, both seeds of common
ground. Walking with *Draw around this* moves the pin with you.

The walk is visible: a strip under the bar lists the articles you have drawn around —
*Physics → Einstein → Curie* — each a link back to that disc. Jumping along it moves a
marker; stepping somewhere new from the middle branches from there. Session-only, cleared
with ×; past eight steps the middle collapses to an ellipsis.

Every view is a URL. The controls mirror into the hash —
`#view=path&q=Cheese&q2=Black+hole&limit=1000` — so a view can be bookmarked or sent,
and the browser's back button retraces a walk. The detail card's **Draw around this**
makes the article the new centre; each click is a page in the history.

**A reading order (experimental).** *Reading order for Quantum mechanics* reads lead
paragraphs: what an article names before its first heading is the vocabulary it assumes.
Level one is the article's own lead links; level two is what those articles' leads name in
turn, kept only when two or more of them share it — a concept several prerequisites name
is the field's vocabulary, one that a single prerequisite names is that article's own
business (Max Planck's lead names Germany; the field does not). Links inside parentheses
are asides (etymology, pronunciation) and skipped; a short lead reads on into the next
section. On simplewiki: *Mass ×5, Particle ×4, Energy ×4, Speed of light, Science …* then
*Mathematics, Physics, Chemistry, Atom, Electron …* then the article. Some forty fetches,
cached; the set is drawn through `/api/view/set` with the article pinned. Whether the
order convinces is a judgement made on screen, which is why it is marked experimental.

**Full text, not just titles.** The ZIM carries a Xapian index and kiwix-serve exposes it
as an RSS feed (`/search?…&format=xml`, 140 hits a page), so *Articles that mention
"Antwerp"* is the page asking Kiwix for the first thousand hits, four pages in flight at a
time, and posting the titles to `/api/view/set`, which resolves them, applies the filters,
and draws the induced subgraph. On simplewiki: 720 articles mention it, 645 pass the
filters, 1.4 s; the biggest dots are the province, the football club and the city. The
option is only offered when a reader is configured — there is no index without the ZIM.

**Why does A link to B.** A link is a line on the disc; the sentence behind it is the
argument. *?* beside a neighbour on the card fetches the article from Kiwix, finds the first
link to that neighbour in running text (paragraphs and list items — not infoboxes or
navboxes), walks the block's text with references skipped, and cuts the sentence around
the anchor: *Cheese* → *History*: "People have been making cheese since before **history**
was written down." When the article has no such link the edge was drawn the other way, so
the neighbour is searched instead and the answer says so. On a path view the same runs for
every hop and lands under the bar as a numbered explanation of the route — *Science →
Black hole*: "This idea helped scientists understand things like **black holes**…". Parsed
documents are cached, a few dozen at a time, and shared with the preview.

**The card says where an article stands.** Under the preview: *#5,874 of 284,808* by
in-degree (and by PageRank), links in and out over the whole wiki, length — from
`/api/article`, answered by a binary search over a sorted copy of each signal made on first
use. Then the article's categories as chips, hidden ones left out, birth and death years
after the ones that describe the subject, organising ones (stubs, *by year*) last and dimmed.
A chip's name draws that category tree; *only* beside it keeps the current view and narrows
it to the category.

**The article and the disc know about each other.** Every link in the article whose target
is a dot on the disc is underlined in gold (the reader bar counts them: *167 on the disc*
for *Belgium* on *Around Belgium*); the mouse over one lights the dot, a click selects it
and follows the link as usual — reading is not interrupted, the disc keeps up. The other
way round, a neighbour clicked on the card scrolls the article to the sentence where that
link is made and flashes it. The marks are recomputed on every draw, since they are the
intersection of the two: redraw around Physics and *Belgium* has 34 left.

**What changed since last month, per article.** When the refresh has left the previous
dated build beside `current`, the API opens its in-link graph and title table too (~60 MB
resident for enwiki; articles matched by title through the old database's index, one
lookup per question, not a seven-million-entry map). The card then says *since 20260801:
+375 in-links, −2 gone* — *Palestine*, the month *Palestine (country)* was folded into it —
and opens to the titles, arrivals first by importance; one on the disc selects its dot, one
off it draws around it. *New links* in the bar is the same as a lens: every drawn link that
did not exist in the previous build, either way round, is gold and thicker — *Around Ice
hockey* lights up with the new season's players — and the status line counts them. A
renamed article is all departures under the old title and all arrivals under the new,
which is what happened to the links. Without a second build the checkbox is not offered.

**The disc as a table.** *Table* in the bar lays the same articles over the disc as
sortable rows — title, in-links over the wiki, links on the disc, words, wedge, hop or role,
kind, reading state, last edited — with a text filter and *Copy as Markdown* (a Markdown
table with Kiwix links). The rows are what the disc shows: hide a wedge in the legend or
narrow the date range and they go, through the page's own `willShow()`. A row selects the
dot and opens the article. Nothing is fetched; the view data is already in the page.

**A reading list.** *To read* and *read* on the card and in the reader bar (one button
there, cycling). Marked articles wear a halo on the disc — gold to read, green read — put on
the nodes by the page before the disc is built, and a tag on the card; the *Reading* panel
lists both groups, each a click into the reader. A *reading* filter beside it applies to
every view — *hide read*, *only marked*, *only to read* — on the client, so the server never
hears of it; the seed and a path's steps stay whatever the filter says. *Copy list as
Markdown* puts `- [x] [Brussels](kiwix url) — first sentence` on the clipboard (first
sentences fetched, a few dozen at most), *Copy view as Markdown* the disc's articles with
topic and link count, headed by the view's URL — for notes.

**Saved views** are the same URLs, kept. ★ in the bar saves what is on screen under the
disc's own heading (*Cheese → Black hole (3 hops)*), and turns off again on a view that is
already saved; *Saved (n)* lists them, newest first, each a click back, × forgets one. In
`localStorage`, so per browser and per origin, and nothing goes through the API; *Export*
writes the list as JSON and *Import* merges one in, keyed on the hash, for moving between
machines.

**In-degree is the importance signal throughout** — how the disc ranks a BFS frontier, a
search hit, and the "most linked-to" list. Out-degree measures how much an article lists,
and lists win it: by out-degree simplewiki's top articles are `List of municipalities in
Switzerland` and `Deaths in 2024`. By in-degree they are `United States` and `France`.

**PageRank is available as the alternative signal** — *Rank: by PageRank* — computed at
ingest by power iteration over the CSR (30 iterations; 4 s on simplewiki, minutes on
enwiki) into a float sidecar `<wiki>.rank`, or added to an existing build:

```bash
docker compose --profile ingest run --rm ingest --wiki enwiki --rank-only
```

In-degree counts links; PageRank weighs each by where it comes from, so a navbox on a
thousand stubs counts for less than one link from a major article. At the very top the
two agree, and both still put the infobox vocabulary first — the kind filter remains the
answer for that. They disagree in the middle, which is where a view spends its budget:
*most linked-to* on simplewiki is `United States, France, Communes of France, Departments
of France…`; *highest PageRank* is `United States, France, United Kingdom, English
language, Canada, India…`. Around *Physics* at one hop, in-degree picks *Islam,
Afghanistan, Science fiction* among the first eight; PageRank picks *Mathematics, Science,
Number, Electricity*. The run prints both top-20s side by side.

**Four kinds of page can be hidden from every view** — lists, date pages, disambiguation
pages, and what the UI calls *infobox links*: articles such as `Population`, `Time zone`
or `Wayback Machine` that every place or biography links to from a template. They are
among the most linked-to pages on any Wikipedia and carry no topical signal, and no graph
measure separates them from genuine hubs like `United States`, so they are named in
[`ingest/infrastructure.txt`](ingest/infrastructure.txt). Lists and dates are recognised by
title shape; disambiguation pages by the `page_props` flag, which catches the thousands
whose title does not say so. The classification lives in a one-byte-per-article sidecar,
`<wiki>.kind`, written by the ingest or added to an existing build with:

```bash
docker compose --profile ingest run --rm ingest --wiki enwiki --classify-only
```

That run ends by printing the top 40 articles by in-degree with their kind. Whatever sits
there still labelled *article* is the next candidate for `infrastructure.txt` — or a real
hub that belongs. On simplewiki, hiding all four turns the most-linked-to list from
`Geographic coordinate system, Wayback Machine, Population…` into `United States, France,
Germany, City…`.

**Short articles can be hidden too** — *shorter than 1 KB* by default, which on simplewiki
drops the bottom quarter (median 1.8 KB) and on enwiki rather less. Length is bytes of
wikitext, already in the database and streamed into memory at startup; 1 KB is roughly 150
words. The threshold is a view setting like the kinds, in the URL, and the server's default
is reported by `/api/info` (`MIN_LEN_DEFAULT` in the environment to change it). Raising it
does not shrink the disc — the budget goes to better-connected articles instead: *Around
Physics* at 1,000 nodes has 9,844 links with no floor and 14,141 at 5 KB.

A hidden kind or a short article is refused as a stepping stone in a path search but never
as an endpoint or a seed: those are the user's choice.

**Mutual links only** keeps a link only when it goes both ways. A one-way link is a
mention — an infobox field, a passing reference; a mutual one means the two articles are
about each other. With the toggle on, the neighbourhood BFS follows only mutual links, the
disc draws only mutual edges, and a path is a chain of articles that each refer back to
the previous one. On simplewiki, *Around Physics* at one hop drops from 300 articles and
7,250 links to 85 and 314, and *Quantum mechanics* enters the top ten as the navbox
physicists leave; the two-hop mutual neighbourhood shares only a third of its articles with
the ordinary one and 87% of its internal links are reciprocal. The path *Cheese → History →
Science → Black hole* becomes *Cheese → Bacteria → Water → Universe → Black hole*.

**Any view can be restricted to a category** — *Around Einstein, within Science*. The
category's subtree (three levels, `withindepth` to change it) becomes a one-byte-per-
article mask that every selection tests against, alongside the kind and length filters;
the last few masks are cached, since a walk over a big category is the expensive part of
the request. Seeds and path endpoints are exempt as always. The category view itself does
not offer it — it already is one.

**Wedges by cluster instead of topic.** The topic wedges are how the wiki *files* these
articles; a *Wedges: by cluster* switch replaces them with how the articles actually hang
together — communities found by the Louvain method on the links drawn, each named after
its three most linked-to members. On *Around Physics* that separates the Nobel physicists,
thermodynamics (*Refrigerator, Air conditioner, Viscosity*) and the Greek letters physics
borrows, which the topic view files together under Science; *Around Belgium* falls into
football, Formula One, Flanders, Liège, Antwerp, Leuven. Where the two views disagree is
usually the most interesting thing the graph has to say.

Label propagation was tried first and does not work here: a neighbourhood is a few hubs
and everything they touch, and a hub's label simply floods it — 1,453 of 1,500 nodes in one
community. Modularity asks whether nodes are more connected than their degrees predict,
which a hub cannot win by size alone. The implementation (`api/cluster.mjs`) is
dependency-free, deterministic — same view, same partition, every time — and takes 20–40
ms on a 1,500-node disc.

**Two more lenses.** *Wedges: by hop distance* (`group=hops`, neighbourhood views only)
makes the wedges the shells of the neighbourhood — *the seed*, *1 hop away*, *2 hops away*.
Since the disc rings articles by the links it can see, and everything one hop out is
linked to the seed, the shells come out concentric: on *Around Physics* the inner ring is
the 922 articles Physics links to or is linked from, the outer the 577 they reach. Never
pooled; the seed is a wedge of one on purpose.

*Dots: by in-degree | PageRank | length* (`size=`) changes what a dot's radius shows. By
default it is the degree on the disc, which is also what places the dot. The alternative
travels as a `size` of 0..1 per node — log-scaled and normalised over the selection, since
in-degree runs from one to half a million and on a linear scale every dot but *United
States* would be the minimum — and the page uses it for the radius alone, so switching
lenses changes no dot's place. On a *most linked-to* view by in-degree the largest dots are
*United States* and *France*; the big dots on the rim are the ones the lens exists for —
*Communes of France*, cited by thousands of stubs the length filter hides, so barely linked
on the disc and enormous in the wiki.

**Search is a title index**, FTS5 in its own sidecar `<wiki>.search.db`: each word typed
becomes a prefix term, case-insensitive with diacritics folded, ranked by in-degree. So
"einstein" finds *Albert Einstein* first, "alb ein" finds it too, and "zurich" finds
*Zürich*. Redirect titles are in the index as aliases of their targets — "usa" finds
*United States*, "nyc" *New York City*, and the hit says *via USA* — with one rule the
titles do not have: an alias counts only when it starts with what was typed. A redirect
inherits its target's importance, so any looser match lets a hub in through a side door
("new york" surfaced *Town* through the redirect *Town (New York)*). The aliases come
from a small sidecar `<wiki>.redirects.tsv.gz` the build writes; for a build made before
it existed, `--index-only` derives it once from the page and redirect dumps. Body-text
search is Kiwix's job and already exists in its own UI. Without the search sidecar the API
falls back to a case-sensitive prefix match and says so at startup:

```bash
docker compose --profile ingest run --rm ingest --wiki enwiki --index-only
```

The category view pools its wedges: the twelve biggest subcategories keep their own
slice and the rest share one, labelled with how many were folded in. Categories that
organise rather than describe — stub bins, *Physicists by nationality*, template and list
holders, anything flagged hidden — are walked through but never become a wedge; what is
under them takes the nearest describing ancestor, or the root. And describing categories
claim their members first, so an article filed under both *Biologists* and *Biology stubs*
lands in the former. Before this, *Math stubs* was the largest wedge of Mathematics.

Degree *on the disc* is recomputed over each selection rather than taken globally: the
disc rings articles by the links it can actually see, and a global degree would pull
articles to the centre for links to nodes that are not on screen.

*Common ground* answers a different question from the path: not how to get from one
article to the other, but what they share. Four sorted neighbour lists, two merges; each
result is labelled *both link to it*, *links to both*, or *linked both ways with both*.
With *mutual links only* it tightens to articles mutually linked with both seeds —
*Belgium × Japan* then gives the countries each treats as a peer.

The path search is bidirectional — forward along out-links, backward along in-links,
always growing the smaller side. Wikipedia's link graph has a diameter of a few hops but
hubs with a million in-links; meeting in the middle keeps both frontiers to a few thousand
articles, and a path across simplewiki takes about 5 ms.

## Architecture

```
SQL dumps ──► ingest/build.py ──► <wiki>.csr   ─┐  out-links
                                  <wiki>.rcsr  ─┤  in-links (transposed from .csr)
                                  <wiki>.db    ─┴─► api/server.mjs ──► web/ (the disc)
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
— one seek, no index, no query planner. There are two: `.csr` holds out-links, `.rcsr` the
same edges transposed, so "who links here" is the same single seek in the other file.

The reverse file is derived from the forward one, never from the dumps, so it can be added
to an existing build without rereading anything:

```bash
docker compose --profile ingest run --rm ingest --wiki enwiki --reverse-only
```

A full build and `--meta-only` both produce it as a matter of course; the API refuses to
start without it and prints that command.

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
│   └── 20260901/  enwiki-20260901-*.sql.gz   (a dated set, from refresh.sh)
├── graph/     enwiki.{csr,rcsr,db,kind,rank,search.db,redirects.tsv.gz}
│   ├── 20260901/  the same seven files, one build      (from refresh.sh)
│   └── current -> 20260901                             (the build the API serves)
└── zim/       <ZIM_BOOK>.zim              (Kiwix)
```

A first build sits flat in `graph/`; the monthly refresh below makes dated builds beside a
`current` link. The API prefers `current` when it exists, so the two layouts need no
migration step — the flat files just stop being read, and can be deleted.

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
fetches all six (a third argument, `20260901`, takes that run's files instead of `latest`). It downloads **sequentially on purpose** — `dumps.wikimedia.org` answers
parallel requests from one address with 429, and a 429 lands as a 169-byte HTML error page
wearing a `.sql.gz` name, which then fails deep inside the parser instead of at the
download. Each file is verified with `gzip -t` before it counts as fetched.

### Monthly refresh

Wikimedia publishes new dumps twice a month. One command takes a run to a running API:

```bash
./refresh.sh              # the newest run whose six tables are all published
./refresh.sh 20260901     # that run
./refresh.sh 20260901 --no-swap   # fetch, build and report; keep serving the old build
```

Four steps, each skipped when its output already exists, so a run that died two hours
into the enwiki build is resumed by repeating the command: **fetch** the six dumps into
`dumps/<date>/`; **build** into `graph/<date>/` (the ingest container, local scratch as
always, `build.log` beside the result); **compare** with the build in use; **swap**
`graph/current` to the new build and restart the API, waiting for its health check.

The comparison — `ingest/compare.py`, also on its own — is printed and saved as
`graph/<date>/<wiki>.changes.txt`: article and link counts by kind, the top 40 by
in-degree with their movement (`^ was #7`, `new`), the biggest gains and losses in
in-degree, and the most linked-to titles that arrived and left. Articles are matched by
title, since the CSR index is a build's own numbering; a rename is therefore one departure
and one arrival, which is the truth of it as far as links go. Between simplewiki's August
and September runs: +807 articles, +30,617 links; *Twitter* (1,535 in-links) left and *X
(social platform)* (1,543) arrived; *Palestine (country)* was folded into *Palestine*, the
month's biggest gain; the ice-hockey season started, and the summer transfer window shows
as a column of footballers losing their links.

The swap is a relative symlink written beside the old one and renamed over it, so a
reader sees either build, never none; relative, so it resolves identically on the host and
inside the container. A share that refuses symlinks gets directory renames instead, with
the previous build getting its date back from its `BUILD` marker. The API opens its files
once at startup, so the restart is what switches — `restart: unless-stopped` brings it back
in a few seconds, and the script prints what it is serving once healthy.

Old builds are kept until deleted by hand; a simplewiki build is 250 MB, an enwiki one
about 8 GB. Keep at least the one before `current`: the API opens it for *what changed
since last month* (the card's arrived and left in-links, the *new links* lens). The ZIM is on its own cadence (Kiwix publishes every few months) and stays
manual: `fetch-zim.sh`, then `ZIM_BOOK` in `.env`.

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

Without Caddy — on a laptop, say — set `KIWIX_PROXY=http://localhost:8080` and the API
forwards `/kiwix/*` itself, so the same-origin article fetch works the same way. It is a
development convenience, not a production path.

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
