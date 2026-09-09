"""Streaming readers for MediaWiki SQL dumps.

A dump is one enormous file of `INSERT INTO `t` VALUES (..),(..),(..);` lines. We never
materialise it: each reader yields tuples as they are scanned out of a gzip stream.

Speed comes from giving each table its own regex rather than writing one general SQL
parser. Character-by-character scanning in Python is far too slow for enwiki's 1.6
billion pagelinks rows; `re` runs at C speed, so the work is to write a pattern per
table that is exactly as permissive as that table's columns require and no more.

The one pattern that matters most is `pagelinks`: three integer columns and no strings
at all, which is why it gets the trivial pattern and runs an order of magnitude faster
than the tables carrying `varbinary` titles.
"""

from __future__ import annotations

import gzip
import re
from typing import Callable, Iterator

# Read a megabyte at a time. Tuples never span that, but an INSERT statement does, so
# every reader carries the unconsumed tail of its chunk into the next one.
CHUNK = 1 << 20

# A single-quoted MySQL string: any run of non-quote/non-backslash bytes, or a
# backslash followed by anything. Titles are varbinary and routinely contain quotes,
# commas, parentheses and backslashes, so splitting tuples on `),(` is not safe for any
# table with a title column.
_STR = rb"'(?:[^'\\]|\\.)*'"


def _stream(path: str, pattern: re.Pattern, on_match: Callable) -> Iterator:
    """Scan a gzipped dump, yielding `on_match(m)` for every tuple the pattern finds.

    The tail handling is the whole subtlety: we scan up to the last complete match and
    keep everything after it, so a tuple straddling a chunk boundary is seen once, in
    the next round, rather than being split into two malformed halves or dropped.
    """
    tail = b""
    with gzip.open(path, "rb") as fh:
        while True:
            chunk = fh.read(CHUNK)
            if not chunk:
                break
            buf = tail + chunk
            last = 0
            for m in pattern.finditer(buf):
                last = m.end()
                yield on_match(m)
            # Keep a bounded tail even when nothing matched, or a pathological chunk
            # (the CREATE TABLE preamble, say) would grow `buf` without limit. The cap
            # has to exceed the longest single tuple: `page_props` values are blobs and
            # run to a few KB, so 64 KB leaves room rather than silently dropping a row.
            tail = buf[last:] if last else buf[-(1 << 16):]


def _unescape(raw: bytes) -> str:
    """Turn a quoted MySQL byte string into str, undoing backslash escapes.

    Titles are stored as UTF-8 bytes with underscores for spaces. Anything that does not
    decode is replaced rather than raised: a handful of pages in every wiki carry
    historic mojibake, and losing the whole import to one of them helps nobody.
    """
    s = raw[1:-1]  # strip the surrounding quotes
    if b"\\" in s:
        s = (s.replace(b"\\\\", b"\x00")
              .replace(b"\\'", b"'").replace(b'\\"', b'"')
              .replace(b"\\n", b"\n").replace(b"\\r", b"\r").replace(b"\\t", b"\t")
              .replace(b"\\0", b"").replace(b"\x00", b"\\"))
    return s.decode("utf-8", "replace")


# ---------------------------------------------------------------------------- tables

# page: (id, ns, 'title', is_redirect, is_new, random, 'touched', links_updated,
#        latest, len, content_model, lang)
_PAGE = re.compile(
    rb"\((\d+),(-?\d+)," + _STR + rb",([01]),[01],[\d.eE+-]+,'(\d{14})',"
    rb"(?:NULL|'\d{14}'),\d+,(\d+),"
)
_PAGE_TITLE = re.compile(rb"\(\d+,-?\d+,(" + _STR + rb")")


def pages(path: str) -> Iterator[tuple]:
    """Yield (page_id, namespace, title, is_redirect, touched, length)."""
    def hit(m):
        return (int(m[1]), int(m[2]), _unescape(_PAGE_TITLE.match(m[0])[1]),
                m[3] == b"1", m[4].decode(), int(m[5]))
    return _stream(path, _PAGE, hit)


# linktarget: (lt_id, lt_namespace, 'lt_title')
_LINKTARGET = re.compile(rb"\((\d+),(-?\d+),(" + _STR + rb")\)")


def linktargets(path: str) -> Iterator[tuple]:
    """Yield (lt_id, namespace, title).

    Since MediaWiki 1.41 both `pagelinks` and `categorylinks` reference this table
    instead of storing titles inline, so nothing resolves without it.
    """
    return _stream(path, _LINKTARGET,
                   lambda m: (int(m[1]), int(m[2]), _unescape(m[3])))


# pagelinks: (pl_from, pl_from_namespace, pl_target_id) -- all integers, no strings.
_PAGELINKS = re.compile(rb"\((\d+),(-?\d+),(\d+)\)")


def pagelinks(path: str) -> Iterator[tuple]:
    """Yield (from_page_id, from_namespace, target_lt_id)."""
    return _stream(path, _PAGELINKS,
                   lambda m: (int(m[1]), int(m[2]), int(m[3])))


# redirect: (rd_from, rd_namespace, 'rd_title', interwiki, fragment)
_REDIRECT = re.compile(
    rb"\((\d+),(-?\d+),(" + _STR + rb"),(?:NULL|" + _STR + rb"),(?:NULL|" + _STR + rb")\)")


def redirects(path: str) -> Iterator[tuple]:
    """Yield (from_page_id, target_namespace, target_title)."""
    return _stream(path, _REDIRECT,
                   lambda m: (int(m[1]), int(m[2]), _unescape(m[3])))


# categorylinks: (cl_from, 'sortkey', 'timestamp', 'prefix', type, collation, target_id)
_CATLINKS = re.compile(
    rb"\((\d+)," + _STR + rb"," + _STR + rb"," + _STR +
    rb",'(page|subcat|file)',\d+,(\d+)\)")


def categorylinks(path: str) -> Iterator[tuple]:
    """Yield (from_page_id, membership_type, target_lt_id).

    `membership_type` separates an article filed in a category ('page') from a category
    filed inside a parent category ('subcat'); the second is what makes the category
    tree walkable.
    """
    return _stream(path, _CATLINKS,
                   lambda m: (int(m[1]), m[2].decode(), int(m[3])))


# page_props: (pp_page, 'pp_propname', 'pp_value', pp_sortkey)
_PAGEPROPS = re.compile(
    rb"\((\d+),(" + _STR + rb"),(" + _STR + rb"),(?:NULL|[\d.eE+-]+)\)")


def pageprops(path: str) -> Iterator[tuple]:
    """Yield (page_id, propname, value).

    The property that matters here is `hiddencat`. Most categories on a typical article
    are maintenance bookkeeping -- "Articles with hCards", "Webarchive template wayback
    links" -- and they swamp the topical ones, so the wedges are meaningless until they
    are filtered out. MediaWiki marks them with this flag; guessing from title prefixes
    catches most but not all, and misfires on real topics.
    """
    return _stream(path, _PAGEPROPS,
                   lambda m: (int(m[1]), _unescape(m[2]), _unescape(m[3])))
