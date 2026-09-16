# Transit vehicle glyphs

`bus.svg` and `ferry.svg` are the icons the Transit (Entur) live layer draws on
its map pins (`src/web/pages/map/transit.ts`) and on the masthead's transit
count (`src/web/shell/Masthead.ts`).

Unlike `../signs/` (the vendored Statens vegvesen sign faces), these two are
**original artwork drawn for this project**, not traced or adapted from any
third-party icon set, symbol package or font. They are plain hand-authored SVG
paths — a side-view bus silhouette with two window panes and two wheels, and a
ferry hull with a small mast/funnel above the waterline — sized to read clearly
at the 26–32px a map pin or masthead glyph actually gets.

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
