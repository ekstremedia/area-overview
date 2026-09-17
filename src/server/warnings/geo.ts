/**
 * Polygon-vs-bbox geometry shared by both warnings providers:
 * `met-alerts.ts` needs to know whether an alert's area touches the
 * requested viewport at all, and `regions.ts` needs both that answer and
 * the centroid of the actual overlap (`AvalancheWarningSchema.point`).
 * Nothing else in this codebase does polygon clipping, so this is a new,
 * self-contained module rather than a shared dependency.
 *
 * Coordinates are treated as flat Cartesian pairs throughout, not geodesic
 * ones. That is wrong in the general case, but fine at the scale a single
 * viewport or a forecast region spans, and it is consistent with how the
 * rest of this app (bbox rounding, Leaflet's own drawing) already treats
 * lat/lng -- nothing here introduces a new approximation the app doesn't
 * already make elsewhere.
 */
import type { Bbox } from '../layers/bbox.js';
import type { LatLng } from '../../shared/schemas/common.js';

/** A closed ring of `[lat, lng]` tuples -- this app's own coordinate order, not GeoJSON's `[lng, lat]`. */
export type Ring = [number, number][];

type Point = [number, number];

function lerp(a: Point, b: Point, t: number): Point {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Clips `points` against one half-plane, Sutherland-Hodgman style: keeps
 * every vertex `inside` accepts, and inserts the boundary crossing
 * wherever two consecutive vertices disagree about which side they're on.
 *
 * Iterates with a running `previous` rather than indexing by position,
 * since `noUncheckedIndexedAccess` would otherwise make every `points[i]`
 * a `Point | undefined` for no real safety benefit here -- the loop always
 * has a well-defined previous vertex once `points` is non-empty.
 */
function clipHalfPlane(points: readonly Point[], inside: (p: Point) => boolean, edgeAt: (a: Point, b: Point) => Point): Point[] {
    const last = points[points.length - 1];
    if (last === undefined) return [];

    const output: Point[] = [];
    let previous = last;
    for (const current of points) {
        const currentIn = inside(current);
        const previousIn = inside(previous);
        if (currentIn) {
            if (!previousIn) output.push(edgeAt(previous, current));
            output.push(current);
        } else if (previousIn) {
            output.push(edgeAt(previous, current));
        }
        previous = current;
    }
    return output;
}

/**
 * Clips `ring` to `bbox` -- the polygon-rectangle intersection, computed as
 * four sequential half-plane clips (min lat, max lat, min lng, max lng).
 *
 * Each clip operates against the INFINITE half-plane its bound defines,
 * not just against `bbox`'s own four edges as line segments. That is what
 * makes this correct even when `bbox` sits entirely inside `ring`: no
 * vertex of `ring` lies inside `bbox` in that case, yet the true
 * intersection is `bbox` itself, and four half-plane clips produce exactly
 * that (each clip only removes the part of the (already-clipped) polygon
 * outside its own half-plane, so after all four only the part inside all
 * four -- the bbox rectangle -- can remain).
 */
export function clipRingToBbox(ring: Ring, bbox: Bbox): Ring {
    if (ring.length < 3) return [];

    let points: Point[] = ring;
    points = clipHalfPlane(
        points,
        (p) => p[0] >= bbox.minLat,
        (a, b) => lerp(a, b, (bbox.minLat - a[0]) / (b[0] - a[0])),
    );
    points = clipHalfPlane(
        points,
        (p) => p[0] <= bbox.maxLat,
        (a, b) => lerp(a, b, (bbox.maxLat - a[0]) / (b[0] - a[0])),
    );
    points = clipHalfPlane(
        points,
        (p) => p[1] >= bbox.minLng,
        (a, b) => lerp(a, b, (bbox.minLng - a[1]) / (b[1] - a[1])),
    );
    points = clipHalfPlane(
        points,
        (p) => p[1] <= bbox.maxLng,
        (a, b) => lerp(a, b, (bbox.maxLng - a[1]) / (b[1] - a[1])),
    );
    return points;
}

/**
 * Whether `ring` and `bbox` share any area at all -- not just any clipped
 * vertices. A point-count check alone (`length >= 3`) is not enough: a
 * ring that shares exactly one boundary edge with `bbox` clips to three or
 * four COLLINEAR points, which passes a bare length check while enclosing
 * zero area. That is a real edge-touch, not an overlap, and (per this
 * layer's own reasoning for a corner-only touch, below) not worth spending
 * a gate token or drawing a warning for. So this checks the clipped ring's
 * signed area against the same epsilon `ringCentroid` uses to detect a
 * degenerate polygon, rather than just its vertex count.
 *
 * A corner-only touch (a clip result of one or two points) still can't
 * even form a ring, so it is rejected before the area check runs at all.
 */
export function ringIntersectsBbox(ring: Ring, bbox: Bbox): boolean {
    const clipped = clipRingToBbox(ring, bbox);
    if (clipped.length < 3) return false;
    return Math.abs(signedArea(clipped)) >= CENTROID_AREA_EPSILON;
}

/** The shoelace signed area of `ring`, treating lat/lng as flat Cartesian coordinates (see this file's header). Shared by `ringIntersectsBbox` (a zero-area check) and `ringCentroid` (the same formula, scaled). */
function signedArea(ring: Ring): number {
    const last = ring[ring.length - 1];
    if (last === undefined) return 0;

    let area = 0;
    let previous = last;
    for (const current of ring) {
        const [lat1, lng1] = previous;
        const [lat2, lng2] = current;
        area += lat1 * lng2 - lat2 * lng1;
        previous = current;
    }
    return area / 2;
}

/**
 * Below this, a polygon's signed area is treated as zero -- the leftover
 * sliver from clipping exactly along one line, where the centroid formula
 * below would otherwise divide by (approximately) zero.
 */
const CENTROID_AREA_EPSILON = 1e-12;

/**
 * The area-weighted centroid of `ring` (the standard shoelace-based
 * polygon centroid formula, treating lat/lng as flat Cartesian
 * coordinates -- see this file's header). Falls back to the plain average
 * of vertices for a near-zero-area ring, which the formula itself cannot
 * handle.
 */
export function ringCentroid(ring: Ring): LatLng {
    const last = ring[ring.length - 1];
    if (last === undefined) {
        throw new Error('ringCentroid: ring must have at least one point');
    }

    let area = 0;
    let cLat = 0;
    let cLng = 0;
    let previous = last;
    for (const current of ring) {
        const [lat1, lng1] = previous;
        const [lat2, lng2] = current;
        const cross = lat1 * lng2 - lat2 * lng1;
        area += cross;
        cLat += (lat1 + lat2) * cross;
        cLng += (lng1 + lng2) * cross;
        previous = current;
    }
    area /= 2;

    if (Math.abs(area) < CENTROID_AREA_EPSILON) {
        const avgLat = ring.reduce((sum, [lat]) => sum + lat, 0) / ring.length;
        const avgLng = ring.reduce((sum, [, lng]) => sum + lng, 0) / ring.length;
        return { lat: avgLat, lng: avgLng };
    }

    return { lat: cLat / (6 * area), lng: cLng / (6 * area) };
}
