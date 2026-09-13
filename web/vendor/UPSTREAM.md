# Provenance

This directory started as a verbatim copy of
[luke321/vault-graph](https://github.com/luke321/vault-graph) `src/` at commit
`4a4960ba89638f7b854e897025f0a308d09bb930` (v2.3.0, 2026-09-09), plus the engine bundled
from `src/engine/` with esbuild. That verbatim import is commit `afcc942` in this repository.

It is no longer verbatim. The user-facing vocabulary has been changed from Obsidian's
(vault, note, folder) to Wikipedia's (wiki, article, topic), and the detail card gained
three host callbacks: `deps.articleHref(label)` supplies the open button's target instead
of a hardcoded `obsidian://` URL, `deps.onRecenter(label)` adds a "Draw around this"
button when present, `deps.articlePreview(label, el)` is handed an empty element in
the card to fill (here, the article's first paragraph), and `deps.onOpen(label, href)`
receives a plain click on the open button (modifier-clicks still follow the href), and
`deps.articleFacts(label, el)` is handed a second empty element under the preview, one that
does not clip (rank and categories go there). With `deps.linkWhy(from, to, el)` present, each
neighbour on the card gets a *?* that opens an element under the row for the host to fill
(the sentence making the link). `deps.articleActions(label, el)` gets a span in the actions row
for the host's own buttons, and a node's `mark` ("toread" | "read") is drawn as a halo, and an edge with weight 2 (the host's "new since last month") in gold. A `#vg-follow` button beside the camera controls toggles whether selecting an
article flies the camera to it (`deps.followZoom` initial value, `deps.onFollowZoom` on change).
Edges may carry `d` (1 s→t, 2 t→s, 3 both): the card's neighbour list shows it as an arrow
and can sort by it, and `deps.edgeLens` / `api.setEdgeLens("direction")` colour the disc by it. `page.css` gained the `.preview`
rules beside the card's other styles. The sidebar gained *Export CSV* / *Export JSON* beside *Save PNG*, exporting what the
disc shows by the planner's own `willShow()` test. A node may carry an optional `size` (0..1);
when it does, the dot's radius comes from it rather than from the degree, which still
places the dot. The object `mountVaultGraph` returns exposes `api.idOf(label)`, `api.hover(label)`
and `api.select(label)` and `api.willShow(id)`, so the host can address dots by title and ask what is shown, and the card's neighbour
list calls `deps.onNeighbour(from, to)`. Layout, rendering and interaction are otherwise
untouched.

## Pulling in an upstream release

```bash
git diff afcc942 HEAD -- web/vendor/ > /tmp/wikigraph-ui.patch   # our changes
# replace page.js / page.css / page.html with upstream's src/, rebuild engine.js
git apply --3way /tmp/wikigraph-ui.patch                           # re-apply ours
```

Conflicts, if any, will be in the strings this file describes.
