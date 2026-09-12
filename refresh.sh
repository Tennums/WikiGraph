#!/usr/bin/env bash
# Monthly refresh: a dated dump set in, a running API out, and a report of what moved.
#
#   ./refresh.sh                    # newest complete run on dumps.wikimedia.org
#   ./refresh.sh 20260901           # that run
#   ./refresh.sh 20260901 --no-swap # fetch, build, report; leave the old build serving
#
# Runs on the Docker host, from the repository directory, and reads WIKI and DATA_DIR
# from .env. In order:
#
#   1. fetch    the six dumps into  <DATA_DIR>/dumps/<date>/     (fetch-dumps.sh)
#   2. build    the graph into      <DATA_DIR>/graph/<date>/     (the ingest container)
#   3. compare  with the build in use; the report goes to the terminal and to
#               <DATA_DIR>/graph/<date>/<WIKI>.changes.txt        (ingest/compare.py)
#   4. swap     <DATA_DIR>/graph/current -> <date>, restart the API, wait for healthy
#
# Every step is skipped when its output is already there, so a run that died in the
# build (two hours for enwiki) is resumed by running the same command again, and a
# --no-swap build is switched to later with the same command minus the flag. Old builds
# are kept; delete a dated directory by hand when its disk is wanted back.
#
# `current` is a relative symlink, so it resolves the same on the host and inside the
# container, where the graph directory is mounted at another path. The API prefers
# `current` when it exists and otherwise reads the flat layout, so the first refresh
# needs no migration: the flat files it supersedes just stop being read.
#
# The ZIM is on its own cadence (Kiwix publishes every few months) and stays manual:
# fetch-zim.sh, then ZIM_BOOK in .env.
set -euo pipefail
cd "$(dirname "$0")"

DATE=""; SWAP=1; REBUILD=0
for a in "$@"; do
  case "$a" in
    --no-swap) SWAP=0 ;;
    --rebuild) REBUILD=1 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) DATE="$a" ;;
    *) echo "refresh: unknown argument $a" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "refresh: no .env here -- cp .env.example .env and set WIKI and DATA_DIR" >&2; exit 1; }
set -a; . ./.env; set +a
WIKI="${WIKI:-simplewiki}"
DATA_DIR="${DATA_DIR:-/media/vault/WikiGraph}"
UA="wikigraph/0.1 (+https://github.com/)"
say() { printf '\n== %s  (%s)\n' "$*" "$(date '+%H:%M')"; }

# ---- which run ---------------------------------------------------------------------
# The newest dated directory that already lists all six tables. A table still being
# written carries an .inprog suffix, so the final name appearing means it is done; the
# run as a whole may still be at the (much larger) XML dumps, which this does not need.
if [ -z "$DATE" ]; then
  say "finding the newest complete run for $WIKI"
  for d in $(curl -fsS -A "$UA" "https://dumps.wikimedia.org/$WIKI/" \
             | grep -o 'href="[0-9]\{8\}/"' | grep -o '[0-9]\{8\}' | sort -r | head -4); do
    listing=$(curl -fsS -A "$UA" "https://dumps.wikimedia.org/$WIKI/$d/") || continue
    ok=1
    for t in page pagelinks linktarget redirect categorylinks page_props; do
      echo "$listing" | grep -q "$WIKI-$d-$t.sql.gz\"" || { ok=0; break; }
    done
    if [ "$ok" = 1 ]; then DATE="$d"; break; fi
    echo "   $d: not all tables are there yet"
  done
  [ -n "$DATE" ] || { echo "refresh: no complete run among the last four" >&2; exit 1; }
  echo "   $DATE"
fi

DUMPS="$DATA_DIR/dumps/$DATE"
GRAPH="$DATA_DIR/graph"
BUILD="$GRAPH/$DATE"
mkdir -p "$GRAPH"

# The build in use: `current` if the refresh has run before, else the flat layout.
# Paths on the host and the same paths as the ingest container sees them.
if [ -d "$GRAPH/current" ]; then OLD="$GRAPH/current"; OLD_IN="/data/graph/current"
elif [ -f "$GRAPH/$WIKI.csr" ]; then OLD="$GRAPH"; OLD_IN="/data/graph"
else OLD=""; OLD_IN=""; fi
if [ -f "$GRAPH/current/BUILD" ] && [ "$(cat "$GRAPH/current/BUILD")" = "$DATE" ]; then
  echo "refresh: $DATE is already the build in use"; exit 0
fi

# ---- 1. fetch ------------------------------------------------------------------------
say "1/4 dumps for $WIKI $DATE -> $DUMPS"
./fetch-dumps.sh "$WIKI" "$DUMPS" "$DATE"

# ---- 2. build ------------------------------------------------------------------------
# BUILD, the marker with the run's date, is written last, so its presence means the
# build finished. The ingest reads /data/dumps and writes /data/graph inside the
# container; the dated subdirectories are the same ones as on the host.
say "2/4 build -> $BUILD"
if [ "$REBUILD" = 0 ] && [ -s "$BUILD/BUILD" ]; then
  echo "   have it (--rebuild to redo)"
else
  mkdir -p "$BUILD"
  docker compose --profile ingest run --rm -T ingest \
    --wiki "$WIKI" --dumps "/data/dumps/$DATE" --out "/data/graph/$DATE" \
    2>&1 | tee "$BUILD/build.log"
  [ -s "$BUILD/$WIKI.rank" ] || { echo "refresh: build did not finish; see $BUILD/build.log" >&2; exit 1; }
  echo "$DATE" > "$BUILD/BUILD"
fi

# ---- 3. compare ----------------------------------------------------------------------
say "3/4 what changed"
REPORT="$BUILD/$WIKI.changes.txt"
if [ -z "$OLD" ]; then
  echo "   first build; nothing to compare with"
elif [ -s "$REPORT" ]; then
  cat "$REPORT"
else
  # Same image, other entrypoint: numpy is there and both builds are under /data/graph.
  docker compose --profile ingest run --rm -T --entrypoint python ingest \
    ingest/compare.py --wiki "$WIKI" "$OLD_IN" "/data/graph/$DATE"
fi

# ---- 4. swap -------------------------------------------------------------------------
say "4/4 swap"
if [ "$SWAP" = 0 ]; then
  echo "   --no-swap: $OLD stays in use; to switch later:  ./refresh.sh $DATE"
  exit 0
fi
# A new symlink beside the old one, then one rename over it: a reader sees either the
# old target or the new, never nothing. GNU `mv -T` is what makes the rename replace the
# link rather than move into the directory it points at; BSD mv has no -T, and there the
# old link is removed first (the API only reads the link at startup, so the gap is
# harmless). On a share that refuses symlinks the build is moved into place under the
# name `current` instead, and the one it replaces gets its date back from its marker.
rm -f "$GRAPH/current.new"
if ln -s "$DATE" "$GRAPH/current.new" 2>/dev/null; then
  mv -T "$GRAPH/current.new" "$GRAPH/current" 2>/dev/null \
    || { rm -f "$GRAPH/current"; mv "$GRAPH/current.new" "$GRAPH/current"; }
  echo "   current -> $DATE"
else
  echo "   $GRAPH does not take symlinks; renaming directories instead"
  if [ -d "$GRAPH/current" ]; then
    prev=$(cat "$GRAPH/current/BUILD" 2>/dev/null || echo previous)
    mv "$GRAPH/current" "$GRAPH/$prev"
    echo "   previous build kept as $GRAPH/$prev"
  fi
  mv "$BUILD" "$GRAPH/current"
  echo "   current = $DATE"
fi

docker compose restart api
printf '   waiting for the API'
s=none
for _ in $(seq 1 60); do
  s=$(docker inspect --format '{{.State.Health.Status}}' wikigraph 2>/dev/null || echo none)
  [ "$s" = healthy ] && break
  printf '.'; sleep 2
done
echo
if [ "$s" = healthy ]; then
  docker compose exec -T api node -e \
    "fetch('http://localhost:3000/api/info').then(r=>r.json()).then(j=>console.log('   serving', j.wiki, 'build', j.build, '--', Number(j.nodes).toLocaleString(), 'articles,', Number(j.edges).toLocaleString(), 'links, built', j.built))"
else
  echo "refresh: API is '$s' after two minutes; see  docker compose logs api" >&2; exit 1
fi
