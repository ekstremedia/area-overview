# Vendored Statens vegvesen sign faces

The four traffic-sign SVGs in this directory are the artwork the Veg layer's map
pins and popups draw (`src/web/pages/map/roads.ts`). They are the real, official
sign faces — not a house redraw of them — because a sign a driver already knows
is read across a room faster than any icon this project could invent.

## Source

- **Package**: the Geonorge symbol package "Trafikkskilt", published by Statens
  vegvesen —
  <https://register.geonorge.no/symbol/symbolpackages/details/1e2f592a-1d69-45a3-9ce1-e55a64fe1dc3>
  (package id `1e2f592a-1d69-45a3-9ce1-e55a64fe1dc3`).
- **Downloaded**: 2026-09-13, as the individual files `110_0.svg`, `302_0.svg`,
  `775_0.svg`, `156_0.svg`.
- Vegvesen's own download page offers EPS rather than SVG, and there is no
  GitHub repository and no symbol API — NVDB serves sign _placements_, not
  artwork — so Geonorge is the only SVG source.

## Licence and attribution

The dataset is published under **NLOD** (norsk lisens for offentlige data) —
<https://dataut.vegvesen.no/dataset/trafikkskilt> — which permits any use,
modification and redistribution, with attribution required:

> Inneholder data under norsk lisens for offentlige data (NLOD) tilgjengeliggjort
> av Statens vegvesen.

That sentence belongs in the project `README.md`; the map footer carries the
short form `Data: Statens vegvesen`.

Independently of the licence, the sign _designs_ are outside copyright
altogether: they are regulation content under **åndsverkloven § 14**, which
exempts laws, regulations and other official decisions from protection.

## Why the faces stay inside pins and popups

**Vegtrafikkloven § 7** forbids putting up traffic signs, or anything that can be
confused with them, on or beside a road without permission. It addresses physical
signage rather than screens, and no primary source extends it to a web UI — but it
is the reason these faces are only ever rendered small, inside a map pin (32 px)
or beside a popup heading (48 px), and are **never rendered full-bleed**. Nothing
in this app should ever display one at a size or in a frame that could read as an
actual sign.

## Which sign means what

| File      | Sign                   | Used for                                                     |
| --------- | ---------------------- | ------------------------------------------------------------ |
| `110.svg` | 110 Vegarbeid          | roadworks (`kind === 'roadworks'`)                           |
| `302.svg` | 302 Innkjøring forbudt | a closed road (`closed`), whatever caused it                 |
| `775.svg` | 775 Bilferje           | ferry notices (`kind === 'ferry'`)                           |
| `156.svg` | 156 Annen fare         | everything else — weather, obstructions, accidents, the rest |

**204 Stopp is deliberately not used.** It means stop completely and yield at a
junction or level crossing; it does not mean "road closed", and mapping it to one
would put a sign on the map that says something the data never said.

## What was changed from the downloaded files

Every path is upstream's own: no point was moved, added or removed, and no shape
was redrawn. The coordinates themselves were shortened, as the last bullet
records. The files were optimised for inline use at 32–48 px only:

- the `<?xml …?>` declaration and the SVG 1.1 DOCTYPE were dropped (an inlined
  fragment needs neither);
- `width`/`height` were dropped and the `viewBox` kept, so CSS sizes them;
- the artboard backdrop — the first `<g id="#ffffffff">` group, whose paths fill
  the corners _around_ the sign with opaque white — was removed, so a pin shows
  the sign face on its own plate rather than a white square. Every sign's own
  inner white field is a separate, slightly off-white group (`#fbfbfb`,
  `#f9f9f9`) or, for 110, the yellow field, so none of it was touched;
- `<g id="…">` attributes were dropped: they merely repeat the fill colour,
  nothing references them, and four inlined copies on one page would be four
  duplicate DOM ids;
- `opacity="1.00"` (the default) was dropped;
- path coordinates were rounded from two decimals to one. The artboards are not
  all one size — `110.svg` and `156.svg` are `0 0 905 792`, `302.svg` is
  `0 0 1206 1206`, `775.svg` is `0 0 679 679` — so the error is worst on the
  smallest, 775's 679 units: rounding moves a coordinate by at most 0.05 units,
  which at 48 px is under 0.004 px. On 302's 1206-unit artboard it is half that.

Rendering before and after was compared in a real browser at 120 px, 48 px, 32 px
and 24 px, against both a dark and a light-olive background; the faces are
identical.
