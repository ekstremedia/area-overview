/**
 * Pure, Leaflet-free logic for the fading tail drawn behind a moving ship
 * or aircraft: accumulating a position history, and turning it into the
 * per-segment opacities that produce the fade. `trailLayer.ts` is the only
 * Leaflet-touching consumer -- everything here is unit-tested directly, no
 * map required, same split as `glyphs.ts`/`canvasGlyphLayer.ts`.
 *
 * Neither upstream returns track history: `/api/ships` and `/api/aircraft`
 * each report where a vessel is *now*, once per poll. A trail is therefore
 * something this app remembers rather than something it fetches -- it
 * starts empty on every page load and fills in over the following minutes,
 * and it can only ever be as detailed as the poll interval (a ship's
 * 15-second steps, not a smooth curve).
 */

export interface TrailPoint {
    lat: number;
    lng: number;
    /** When the position was reported (the glyph's own `timestamp`), not when this app noticed it -- so a stale repeat of an old position ages out on its real age. */
    at: number;
}

export interface AppendTrailOptions {
    /** Points to keep per glyph. With ships polling every 15s, 10 points is ~2.5 minutes of track. */
    maxPoints: number;
    /** Points older than this are dropped. Bounds how far back a trail reaches in *time*, independently of `maxPoints`, so a vessel that vanishes and returns later doesn't get a straight line drawn across the gap. */
    maxAgeMs: number;
}

/**
 * Returns `points` with `next` appended, aged-out points dropped and the
 * result capped to `maxPoints` (newest kept). Pure: never mutates its
 * input.
 *
 * A position identical to the newest point is *not* appended -- a moored
 * ship reports the same coordinates every poll, and stacking duplicates
 * would push the real history out of the cap without drawing anything.
 * A repeat of the same *timestamp* is dropped for the same reason: an
 * upstream that hasn't heard from a vessel since the last poll re-serves
 * the previous fix rather than a new one.
 */
export function appendTrailPoint(points: readonly TrailPoint[], next: TrailPoint, options: AppendTrailOptions): TrailPoint[] {
    const newest = points[points.length - 1];
    const isRepeat = newest !== undefined && ((newest.lat === next.lat && newest.lng === next.lng) || newest.at === next.at);
    const withNext = isRepeat ? [...points] : [...points, next];
    const cutoff = next.at - options.maxAgeMs;
    const fresh = withNext.filter((point) => point.at >= cutoff);
    return fresh.length > options.maxPoints ? fresh.slice(fresh.length - options.maxPoints) : fresh;
}

export interface TrailSegment {
    from: TrailPoint;
    to: TrailPoint;
    /** `0` (invisible) to `1` (fully opaque). */
    opacity: number;
}

export interface TrailSegmentOptions {
    /** Opacity of the newest segment, the one touching the glyph. Below 1 deliberately: the tail is context, and must not compete with the glyph itself. */
    newestOpacity: number;
    /** Opacity of the oldest segment. Above 0 so the tail's far end is faint rather than absent. */
    oldestOpacity: number;
}

/**
 * Turns a position history into the drawable segments between consecutive
 * points, oldest first, with opacity ramping linearly from
 * `oldestOpacity` to `newestOpacity` -- which is what makes the tail read
 * as pointing *back* the way the vessel came.
 *
 * Fewer than two points yields no segments (nothing to draw between), and
 * a two-point history yields one segment drawn at `newestOpacity`: with
 * only one segment there is no ramp to show, and the surviving one is the
 * freshest.
 */
export function trailSegments(points: readonly TrailPoint[], options: TrailSegmentOptions): TrailSegment[] {
    const segmentCount = points.length - 1;
    if (segmentCount < 1) return [];
    const segments: TrailSegment[] = [];
    for (let index = 0; index < segmentCount; index++) {
        const from = points[index];
        const to = points[index + 1];
        if (from === undefined || to === undefined) continue; // unreachable given the bounds above; satisfies noUncheckedIndexedAccess
        const ramp = segmentCount === 1 ? 1 : index / (segmentCount - 1);
        segments.push({ from, to, opacity: options.oldestOpacity + (options.newestOpacity - options.oldestOpacity) * ramp });
    }
    return segments;
}
