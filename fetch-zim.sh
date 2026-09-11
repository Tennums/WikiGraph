#!/usr/bin/env bash
# Fetch one ZIM from the Kiwix library, resumably, and verify it.
#
#   ./fetch-zim.sh wikipedia_en_all_maxi_2026-08 /media/vault/WikiGraph/zim
#
# The full English ZIM is ~119 GB. Two things matter at that size and this script
# does both: it resumes (`curl -C -`) so a dropped connection costs nothing, and it
# checks the published SHA-256 at the end, because a truncated or corrupt ZIM does not
# fail loudly -- kiwix-serve opens it and some articles simply come back wrong.
#
# download.kiwix.org is a load balancer that redirects to a mirror near you; -L
# follows it. If you would rather use BitTorrent for a file this size (Kiwix
# recommends it), the same name with .torrent or .magnet appended is published
# alongside -- just run the checksum step afterwards.
set -euo pipefail

NAME="${1:?usage: fetch-zim.sh <zim name without .zim> [dest dir]}"
DEST="${2:-data/zim}"
NAME="${NAME%.zim}"
BASE="https://download.kiwix.org/zim/wikipedia"
UA="wikigraph/0.1"

mkdir -p "$DEST"
ZIM="$DEST/$NAME.zim"

echo "fetching $NAME.zim -> $DEST"
# --retry covers transient mirror errors; -C - resumes from whatever is on disk.
# Retried resumes are exactly what make a 119 GB download survive a flaky evening.
curl -fL --retry 20 --retry-delay 15 --retry-all-errors -C - -A "$UA" \
     -o "$ZIM" "$BASE/$NAME.zim"

echo "verifying ..."
EXPECTED=$(curl -fsL -A "$UA" "$BASE/$NAME.zim.sha256" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "no published checksum for $NAME.zim -- cannot verify" >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  ACTUAL=$(sha256sum "$ZIM" | awk '{print $1}')
else
  ACTUAL=$(shasum -a 256 "$ZIM" | awk '{print $1}')
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "CHECKSUM MISMATCH for $ZIM" >&2
  echo "  expected $EXPECTED" >&2
  echo "  got      $ACTUAL" >&2
  echo "  the file is corrupt; delete it and run this again" >&2
  exit 1
fi

echo "ok: $ZIM ($(du -h "$ZIM" | cut -f1)), checksum verified"
echo "set in .env:  ZIM_BOOK=$NAME"
