#!/usr/bin/env python3
"""Regenerate the favicon set from the disc motif. Run from the repo root:

    .venv/bin/python tools/make-icons.py

Four wedges in the disc's own palette, two rings of dots, the pinned article as the hub.
SVG for browsers that take it; PNGs rendered at 4x and downsampled so the dots stay
round; a 180px plate with rounded corners for an iOS home screen, which masks its own
corners and reads a plate better than a floating disc.
"""
import math, pathlib
from PIL import Image, ImageDraw

WEDGES = ["#3987e5", "#e5732e", "#b04ae5", "#2ec4a0"]
HUB, PLATE = "#e8e8ea", "#14161a"
OUT = pathlib.Path(__file__).resolve().parent.parent / "web"


def dots(size):
    c = size / 2
    out = []
    for radius, count, dot in [(0.42, 24, 0.055), (0.29, 14, 0.048)]:
        R = radius * size
        for i in range(count):
            a = 2 * math.pi * i / count - math.pi / 2
            out.append((c + R * math.cos(a), c + R * math.sin(a), dot * size,
                        WEDGES[(i * len(WEDGES)) // count]))
    out.append((c, c, 0.085 * size, HUB))
    return out


def svg():
    body = [f'<circle cx="32" cy="32" r="32" fill="{PLATE}"/>']
    body += [f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}" fill="{col}"/>' for x, y, r, col in dots(64)]
    (OUT / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n' + "\n".join(body) + "\n</svg>\n")


def png(size, name, rounded=False):
    S = size * 4
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=PLATE)
    else:
        d.ellipse([0, 0, S - 1, S - 1], fill=PLATE)
    for x, y, r, col in dots(S):
        d.ellipse([x - r, y - r, x + r, y + r], fill=col)
    im.resize((size, size), Image.LANCZOS).save(OUT / name)


if __name__ == "__main__":
    svg()
    png(32, "favicon-32.png")
    png(180, "apple-touch-icon.png", rounded=True)
    png(512, "icon-512.png", rounded=True)
    print("wrote favicon.svg, favicon-32.png, apple-touch-icon.png, icon-512.png to", OUT)
