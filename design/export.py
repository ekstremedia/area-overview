#!/usr/bin/env python3
"""Turn the Claude Design artboard file into a static HTML page.

`area-overview-kiosk.dc.html` is the source of truth, exported from the
Claude Design project "Norwegian Aurora App Design". It only renders inside
Claude Design's runtime (`support.js`, React), so this script rewrites it
into `artboards.html`, which any browser opens: the `<helmet>` becomes the
`<head>`, the `<sc-if>` toggles are resolved to their "shown" state, and the
one templated value (the night-mode dim opacity) is fixed at the design's
default of 62 %.

Run it again after re-exporting the .dc.html from Claude Design:

    python3 design/export.py
"""
from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "area-overview-kiosk.dc.html"
TARGET = HERE / "artboards.html"
DIM_OPACITY = "0.62"

src = SOURCE.read_text(encoding="utf-8")
body = src[src.index("<x-dc>") + len("<x-dc>") : src.index("</x-dc>")]

helmet_match = re.search(r"<helmet>(.*?)</helmet>", body, re.S)
if helmet_match is None:
    raise SystemExit("no <helmet> block in the source artboard file")
head = helmet_match.group(1)
body = body.replace(helmet_match.group(0), "")

head = head.replace('<meta name="design_doc_mode" content="canvas">\n', "")
head = re.sub(r"_ds/broadsheet-[0-9a-f-]+/styles\.css", "broadsheet/styles.css", head)

body = re.sub(r"<sc-if[^>]*>", "", body).replace("</sc-if>", "")
body = body.replace("{{ dimOpacity }}", DIM_OPACITY)

html = (
    "<!DOCTYPE html>\n"
    '<html lang="nb">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    "<title>Området — Broadsheet nattutgave (artboards)</title>\n"
    "<!-- Static export of the Claude Design artboards. Source of truth: "
    "design/area-overview-kiosk.dc.html. Regenerate with design/export.py. -->"
    f"{head}</head>\n<body>{body}</body>\n</html>\n"
)
TARGET.write_text(html, encoding="utf-8")
print(f"wrote {TARGET.relative_to(HERE.parent)} ({len(html)} bytes)")
