# Provenance

This directory started as a verbatim copy of
[luke321/vault-graph](https://github.com/luke321/vault-graph) `src/` at commit
`4a4960ba89638f7b854e897025f0a308d09bb930` (v2.3.0, 2026-09-09), plus the engine bundled
from `src/engine/` with esbuild. That verbatim import is commit `afcc942` in this repository.

It is no longer verbatim. The user-facing vocabulary has been changed from Obsidian's
(vault, note, folder) to Wikipedia's (wiki, article, topic), and the detail card gained
two host callbacks: `deps.articleHref(label)` supplies the open button's target instead
of a hardcoded `obsidian://` URL, and `deps.onRecenter(label)` adds a "Draw around this"
button when present. Layout, rendering and interaction are untouched.

## Pulling in an upstream release

```bash
git diff afcc942 HEAD -- web/vendor/ > /tmp/wikigraph-ui.patch   # our changes
# replace page.js / page.css / page.html with upstream's src/, rebuild engine.js
git apply --3way /tmp/wikigraph-ui.patch                           # re-apply ours
```

Conflicts, if any, will be in the strings this file describes.
