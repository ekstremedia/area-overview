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
 *
 * `SHIP_GLYPH_COLOR_UNDERWAY_ENGINE` is a later, separate addition: ships
 * are coloured by AIS `navigationalStatus` (`ships.ts`'s `colorFor`),
 * light blue (`SHIP_GLYPH_COLOR`) by default and this green specifically
 * for status `0` ("under way using engine"). `tokens.css` has no green/
 * success token to mirror (Broadsheet's ramp is only the neutral/cyan/
 * magenta triad above), so this is a freestanding hex literal chosen for
 * legibility against the map's dark tiles and clear visual distinction
 * from the cyan default, not derived from any design token.
 */
export const SHIP_GLYPH_COLOR = '#62c5ee';

/**
 * Aircraft red, per Terje's ask -- they were the design's magenta
 * (`--color-accent-2-400`), which sat close enough to the ships' cyan in
 * peripheral vision on a wall display that a glance didn't separate them.
 * Red does, and nothing else on the map claims it: the warning yellow
 * (`--color-process-yellow`) is the only other alarm-ish colour and reads
 * clearly apart from this at a distance. Like the underway green below,
 * this is a freestanding literal -- Broadsheet's ramp is the
 * neutral/cyan/magenta triad and has no red to mirror.
 */
export const AIRCRAFT_GLYPH_COLOR = '#ff4d4d';

export const SHIP_GLYPH_COLOR_UNDERWAY_ENGINE = '#4ade80';
