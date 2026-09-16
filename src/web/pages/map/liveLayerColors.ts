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
 * the light-edition default) is the exact pair chosen for these
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

/**
 * The Veg layer's three state colours (`roads.ts`): red for a road that
 * is shut, amber for a situation in force right now, grey for one that
 * is not (`scheduled`/`planned`, shown only when
 * `settings.roads.showPlanned` is on).
 *
 * Colour carries *state* here, independently of the sign face on the pin,
 * which carries *kind* -- 110 Vegarbeid, 302 Innkjøring forbudt, 775
 * Bilferje, 156 Annen fare. The two axes are deliberately separate: a
 * closed ferry link and a closed stretch of Fv. 7542 are the same red,
 * and roadworks in force and roadworks starting on Tuesday are the same
 * sign. Either alone is ambiguous at a glance; together they are not.
 *
 * Freestanding literals, for the same two reasons the glyph colours
 * above are: a Leaflet `Path` style and a `CanvasRenderingContext2D`
 * cannot resolve `var(--token)`, and Broadsheet's ramp (neutral/cyan/
 * magenta) has no red, amber or neutral-grey to mirror. The amber is the
 * one Vegvesen's own roadwork signage already trains everyone to read as
 * "work ahead", and sits clearly apart from the aircraft red and the
 * ships' cyan/green on the same map.
 */
export const ROAD_CLOSED_COLOR = '#e23c2e';
export const ROAD_CURRENT_COLOR = '#f0a020';
export const ROAD_PLANNED_COLOR = '#9aa4ad';

/**
 * The Transit (Entur) layer's two pin colours (`transit.ts`'s `colorFor`),
 * driven by `punctualityFor`'s three-way word: on time and running early
 * are the same colour (neither needs attention), and only genuinely late
 * (more than three minutes, `isLateEnoughToTint`) tints the pin.
 *
 * `TRANSIT_ON_TIME_COLOR` is `--color-accent-2-400` -- Broadsheet's own
 * magenta -- resolved to a literal for the same reason every other colour
 * in this file is: a Leaflet `Path`/`L.divIcon` style set from JS needs a
 * literal, not `var(--token)`. It was freed up for reuse here when
 * `AIRCRAFT_GLYPH_COLOR` moved off it (see that constant's own comment) --
 * nothing else on the map claims it now, and reaching for a design token
 * beats yet another freestanding hex where one is actually available.
 *
 * `TRANSIT_LATE_COLOR` reuses `ROAD_CURRENT_COLOR`'s exact amber on
 * purpose: on this map amber already means "in force / needs attention
 * right now" (a roadwork or closure), and a late bus is the same kind of
 * fact.
 */
export const TRANSIT_ON_TIME_COLOR = '#ff90b1';
export const TRANSIT_LATE_COLOR = ROAD_CURRENT_COLOR;

/**
 * The dark casing stroked under every road line before its coloured core
 * (`roads.ts` draws each line twice, weight 7 then weight 4).
 *
 * Without it the amber core disappears into the satellite basemap's
 * sunlit ground and the grey into the dark basemap's own roads -- the
 * line has to survive three very different backdrops, and an outline is
 * how every real map does that. Near-black rather than pure black, which
 * reads as a hole on the dark basemap.
 */
export const ROAD_LINE_CASING_COLOR = '#16191c';
