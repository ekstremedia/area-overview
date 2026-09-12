/**
 * Bbox parsing/clamping/rounding shared by every live-layer route
 * (`ships.ts`, `aircraft.ts`, and any future one) that takes a
 * `?bbox=` viewport query parameter.
 *
 * Query format is the conventional GIS ordering the plan's own example
 * uses -- `minLng,minLat,maxLng,maxLat` (e.g. `14.5,68.3,16.5,69.1`) --
 * even though `Bbox` itself is stored/returned as
 * `{minLat,minLng,maxLat,maxLng}` for readability at every other call
 * site in this module.
 */
import { err, ok, type Result } from '../../shared/result.js';

export interface Bbox {
    minLat: number;
    minLng: number;
    maxLat: number;
    maxLng: number;
}

/**
 * The largest bbox a single request is allowed to ask for, in degrees on
 * a side -- generous enough for any reasonable kiosk zoom level (2° of
 * latitude is roughly 220km), but bounded so a malformed or deliberately
 * huge bbox can't force the BFF to fetch/filter a nationwide dataset on
 * every request. `clampBbox` shrinks around the requested bbox's own
 * center rather than rejecting it outright.
 */
const MAX_SPAN_DEGREES = 2;

/**
 * The grid two nearby viewport bboxes are snapped to before becoming a
 * cache key, so ordinary map panning -- which changes the exact viewport
 * on every frame -- doesn't defeat the server-side cache by missing on
 * every single request. 0.05° is about 5.5km of latitude at this
 * app's latitudes: coarse enough to matter for caching, fine enough that
 * a real pan still gets a fresh-enough bbox once it's moved meaningfully.
 */
const ROUND_PRECISION_DEGREES = 0.05;

/**
 * Absorbs floating-point noise in the grid-cell quotient -- five
 * micrometres' worth of degree, so it can only ever snap a value that is
 * already on a grid line to that line, never move it to a neighbouring
 * one.
 */
const GRID_EPSILON_CELLS = 1e-9;

function isFiniteNumber(value: number): boolean {
    return Number.isFinite(value);
}

/** Parses `raw` as a `minLng,minLat,maxLng,maxLat` query string into a validated `Bbox`. */
export function parseBbox(raw: unknown): Result<Bbox> {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return err({ message: 'bbox query parameter is required and must be "minLng,minLat,maxLng,maxLat"' });
    }

    const parts = raw.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((part) => !isFiniteNumber(part))) {
        return err({ message: 'bbox must be exactly four finite numbers: minLng,minLat,maxLng,maxLat' });
    }

    const [minLng, minLat, maxLng, maxLat] = parts as [number, number, number, number];

    if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) {
        return err({ message: 'bbox coordinates must fall within world bounds (lat -90..90, lng -180..180)' });
    }
    if (!(minLat < maxLat)) {
        return err({ message: 'bbox minLat must be less than maxLat' });
    }
    if (!(minLng < maxLng)) {
        return err({ message: 'bbox minLng must be less than maxLng' });
    }

    return ok({ minLat, minLng, maxLat, maxLng });
}

/** Rounds away the floating-point drift `(center ± span / 2)` arithmetic introduces (e.g. `68.3` becoming `68.29999999999998`), without affecting any value that matters at real-world map precision. */
function roundDrift(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}

/** Shrinks `bbox` around its own center so neither span exceeds `MAX_SPAN_DEGREES`, then re-clips to world bounds. Never rejects -- an oversized bbox is clamped, not a 400. */
export function clampBbox(bbox: Bbox): Bbox {
    const centerLat = (bbox.minLat + bbox.maxLat) / 2;
    const centerLng = (bbox.minLng + bbox.maxLng) / 2;
    const latSpan = Math.min(bbox.maxLat - bbox.minLat, MAX_SPAN_DEGREES);
    const lngSpan = Math.min(bbox.maxLng - bbox.minLng, MAX_SPAN_DEGREES);

    return {
        minLat: roundDrift(Math.max(-90, centerLat - latSpan / 2)),
        maxLat: roundDrift(Math.min(90, centerLat + latSpan / 2)),
        minLng: roundDrift(Math.max(-180, centerLng - lngSpan / 2)),
        maxLng: roundDrift(Math.min(180, centerLng + lngSpan / 2)),
    };
}

/** The grid line at or below `value`. */
function floorToPrecision(value: number): number {
    return roundDrift(Math.floor(value / ROUND_PRECISION_DEGREES + GRID_EPSILON_CELLS) * ROUND_PRECISION_DEGREES);
}

/** The grid line at or above `value`. */
function ceilToPrecision(value: number): number {
    return roundDrift(Math.ceil(value / ROUND_PRECISION_DEGREES - GRID_EPSILON_CELLS) * ROUND_PRECISION_DEGREES);
}

/**
 * Snaps `bbox` out to the `ROUND_PRECISION_DEGREES` grid, so two viewport
 * bboxes close enough not to matter produce the same cache key.
 *
 * **Outward**, not to the nearest line, and that is the whole point.
 * Rounding each edge independently to the nearest line quietly collapsed
 * any viewport narrower than one grid cell: both edges landed on the same
 * line and the result had zero area, so the upstream was asked for a
 * rectangle containing nothing and the layer went empty. That is not an
 * exotic case -- 0.05° is about 2km of latitude on this display, which a
 * 600px-tall map reaches at zoom 13, well inside what a visitor zooms to
 * and exactly where the map's own "zoom to this vessel" lands. Ships and
 * aircraft simply vanished on zooming in, leaving their trails (which the
 * browser remembers) drawn across an empty map.
 *
 * Snapping outward makes the rounded box always *contain* the one asked
 * for, and always at least one cell across, so rounding can never exclude
 * something that was really in view. The cost is fetching a little more
 * water than is on screen, which is the right direction to err: those
 * vessels are already in hand when the visitor pans.
 */
export function roundBbox(bbox: Bbox): Bbox {
    return {
        minLat: floorToPrecision(bbox.minLat),
        minLng: floorToPrecision(bbox.minLng),
        maxLat: ceilToPrecision(bbox.maxLat),
        maxLng: ceilToPrecision(bbox.maxLng),
    };
}

/** A stable string cache key for a (rounded) bbox. */
export function bboxCacheKey(bbox: Bbox): string {
    return `${bbox.minLng.toFixed(3)},${bbox.minLat.toFixed(3)},${bbox.maxLng.toFixed(3)},${bbox.maxLat.toFixed(3)}`;
}
