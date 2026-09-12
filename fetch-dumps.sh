#!/usr/bin/env bash
# Fetch the six dumps the ingest needs.
#
#   ./fetch-dumps.sh [WIKI] [DEST] [DATE]
#
# Without a DATE this takes the `latest/` files (named <wiki>-latest-<table>); with one
# (20260901) it takes that run's files (named <wiki>-20260901-<table>), which is what the
# monthly refresh wants: a dated set in its own directory, never overwritten by the next.
# The ingest accepts either naming.
#
# Sequentially, deliberately: dumps.wikimedia.org returns 429 for parallel fetches from
# one address, and a 429 lands as a 169-byte HTML error page with a .sql.gz name that
# then fails deep inside the parser instead of here.
set -euo pipefail

WIKI="${1:-simplewiki}"
DEST="${2:-data/dumps}"
DATE="${3:-latest}"
BASE="https://dumps.wikimedia.org/${WIKI}/${DATE}"
UA="wikigraph/0.1 (+https://github.com/)"

mkdir -p "$DEST"
for t in page pagelinks linktarget redirect categorylinks page_props; do
  f="${WIKI}-${DATE}-${t}.sql.gz"
  if [ -s "$DEST/$f" ] && gzip -t "$DEST/$f" 2>/dev/null; then
    echo "have  $f"; continue
  fi
  echo "fetch $f"
  curl -fL --retry 5 --retry-delay 10 -A "$UA" -o "$DEST/$f" "$BASE/$f"
  gzip -t "$DEST/$f" || { echo "corrupt: $f" >&2; exit 1; }
done
echo "done -> $DEST"
