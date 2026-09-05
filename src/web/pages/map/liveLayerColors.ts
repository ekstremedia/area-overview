/**
 * Canvas contexts can't resolve CSS custom properties -- a `CanvasRenderingContext2D`
 * (or, here, a Leaflet `Path` style's `color`/`fillColor`) needs a literal
 * colour string, not `var(--color-accent-400)`. These two constants are
 * the one narrow, deliberate exception to "no hex outside tokens.css" in
 * this codebase: they mirror `--color-accent-400` (cyan) and
 * `--color-accent-2-400` (magenta) from `src/web/styles/tokens.css`
 * exactly, and must be kept in sync by hand if those tokens ever change.
 *
 * The 400 step specifically (the dark-edition resolved accent, not 500,
 * the light-edition default) is the exact pair the plan names for these
 * glyphs; it is not conditioned on the shell's current light/dark theme
 * here (unlike `tiles.ts`'s tile choice), since a single fixed, always-
 * legible glyph colour against the map's photographic tiles is simpler
 * and matches the reference artboard.
 */
export const SHIP_GLYPH_COLOR = '#62c5ee';
export const AIRCRAFT_GLYPH_COLOR = '#ff90b1';
