# Live-layer glyphs

`bus.svg` and `ferry.svg` are the icons the Transit (Entur) live layer draws on
its map pins (`src/web/pages/map/transit.ts`) and on the masthead's transit
count (`src/web/shell/Masthead.ts`).

`avalanche.svg` is the icon the Warnings layer draws on its NVE Varsom
avalanche-region pins (`src/web/pages/map/warnings.ts`), alongside the
region's own danger-level digit (1–5) as plain text on the same pin — the
glyph says "avalanche terrain", the digit says how severe.

`bird.svg`, `mammal.svg`, `fish.svg`, `insect.svg` and `plant.svg` are the
per-`class` icons the Species (GBIF) live layer draws on its sighting pins
(`src/web/pages/map/species.ts`), keyed off GBIF's own taxonomic `class`
(`Aves`, `Mammalia`, `Actinopterygii`, `Insecta`, and `Magnoliopsida`/
`Pinopsida` both sharing `plant.svg` — flowering plants and conifers read as
"a plant" at pin size, and the schema keeps `class` an open string rather
than a closed enum precisely because GBIF can report one this app has never
seen). `organism.svg` is the documented fallback for exactly that case: a
plain six-spoke asterisk around a dot, deliberately unlike any of the five
named silhouettes, so a class this app doesn't recognise still reads as "a
living thing", not as a mislabelled bird or fish.

Unlike `../signs/` (the vendored Statens vegvesen sign faces), these are
**original artwork drawn for this project**, not traced or adapted from any
third-party icon set, symbol package or font. They are plain hand-authored SVG
paths — a side-view bus silhouette with two window panes and two wheels, a
ferry hull with a small mast/funnel above the waterline, two overlapping
mountain peaks for the avalanche pin, a two-stroke gull silhouette, a paw
print, a fish body with a tail fin, a four-winged insect body, a single leaf
on its stem, and a generic asterisk-and-dot for the fallback — sized to read
clearly at the 26–32px a map pin or masthead glyph actually gets.

## Licence

Original work, licensed the same as the rest of this repository: **MIT** (see
the project's own `LICENSE`). No external licence or attribution applies.

## Conventions

Same as `../signs/README.md`'s technical notes, for consistency:

- no XML declaration or DOCTYPE (inlined fragments need neither);
- `viewBox` kept, no intrinsic `width`/`height`, so CSS sizes them;
- `fill="currentColor"` (or `stroke="currentColor"` for the ferry's waterline),
  so the glyph takes its pin's colour with no second source of truth for it —
  the same choice `Masthead.ts`'s inline glyphs make.
