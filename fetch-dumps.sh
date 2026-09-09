#!/usr/bin/env bash
# Fetch the five dumps the ingest needs.
#
# Sequentially, deliberately: dumps.wikimedia.org returns 429 for parallel fetches from
# one address, and a 429 lands as a 169-byte HTML error page with a .sql.gz name that
# then fails deep inside the parser instead of here.
set -euo pipefail

WIKI="${1:-simplewiki}"
DEST="${2:-data/dumps}"
BASE="https://dumps.wikimedia.org/${WIKI}/latest"
UA="wikigraph/0.1 (+https://github.com/)"

mkdir -p "$DEST"
for t in page pagelinks linktarget redirect categorylinks page_props; do
  f="${WIKI}-latest-${t}.sql.gz"
  if [ -s "$DEST/$f" ] && gzip -t "$DEST/$f" 2>/dev/null; then
    echo "have  $f"; continue
  fi
  echo "fetch $f"
  curl -fL --retry 5 --retry-delay 10 -A "$UA" -o "$DEST/$f" "$BASE/$f"
  gzip -t "$DEST/$f" || { echo "corrupt: $f" >&2; exit 1; }
done
echo "done -> $DEST"
