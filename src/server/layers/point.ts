/**
 * A visitor's position as it reaches the BFF: validated, rounded, and
 * turned into a cache key.
 *
 * The rounding here is the server-side half of the promise
 * `web/geolocation.ts` makes in the browser. It is applied before *both*
 * the cache key and the upstream call, so a visitor's position is coarse
 * everywhere it exists: in the query string, in this process's memory, and
 * in whatever the upstream logs. It is never persisted server-side at all.
 *
 * Deliberately its own module rather than part of `bbox.ts`: a point and a
 * bounding box are validated differently and cached differently, and the
 * one thing they must not share is `bbox.ts`'s clamping, which exists to
 * bound an *area* request and has nothing to say about a single point.
 */
import { err, ok, type Result } from '../../shared/result.js';

export interface Point {
    lat: number;
    lng: number;
}

/** Matches `POSITION_PRECISION_DECIMALS` in `web/geolocation.ts`. Both halves must agree, or a browser-rounded value would round again to something else and miss the cache. */
export const POINT_PRECISION_DECIMALS = 2;

export function roundPoint(point: Point): Point {
    const factor = 10 ** POINT_PRECISION_DECIMALS;
    return {
        lat: Math.round(point.lat * factor) / factor,
        lng: Math.round(point.lng * factor) / factor,
    };
}

/** True when two positions name the same rounded point. Both sides are rounded first: `settings.homeView` is stored at four decimals, a query arrives at two. */
export function samePoint(a: Point, b: Point): boolean {
    const roundedA = roundPoint(a);
    const roundedB = roundPoint(b);
    return roundedA.lat === roundedB.lat && roundedA.lng === roundedB.lng;
}

function parseCoordinate(raw: unknown): number | undefined {
    if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * The point a request is asking about.
 *
 * `ok(null)` means no coordinates were given -- the home position, which
 * is what the kiosk and every ordinary visitor send, and what keeps them
 * all on one cache key.
 *
 * A lone `lat` or a lone `lng` is an **error**, not a default. That is
 * exactly what the `lon`-versus-`lng` mistake looks like from here (the
 * upstream silently ignores `lon` and answers for Sortland), and quietly
 * treating half a position as no position would turn a client bug into a
 * wrong answer nobody notices.
 */
export function parsePointQuery(query: unknown): Result<Point | null> {
    const source = (query ?? {}) as { lat?: unknown; lng?: unknown };
    const hasLat = source.lat !== undefined && source.lat !== '';
    const hasLng = source.lng !== undefined && source.lng !== '';

    if (!hasLat && !hasLng) return ok(null);
    if (hasLat !== hasLng) return err({ message: 'lat and lng must be given together' });

    const lat = parseCoordinate(source.lat);
    const lng = parseCoordinate(source.lng);
    if (lat === undefined || lng === undefined) return err({ message: 'lat and lng must be numbers' });
    if (lat < -90 || lat > 90) return err({ message: 'lat must be between -90 and 90' });
    if (lng < -180 || lng > 180) return err({ message: 'lng must be between -180 and 180' });

    return ok(roundPoint({ lat, lng }));
}

/** The cache key for a point, or for the home position. `'home'` rather than an empty string so a log line reads plainly. */
export function pointCacheKey(point: Point | null): string {
    if (!point) return 'home';
    const rounded = roundPoint(point);
    return `${rounded.lat.toFixed(POINT_PRECISION_DECIMALS)},${rounded.lng.toFixed(POINT_PRECISION_DECIMALS)}`;
}
