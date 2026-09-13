/**
 * Line simplification for road situations, done once on the server so the
 * same work is not repeated in every browser -- and, more to the point,
 * so the bytes never leave here. Vegvesen's geometry is survey-grade:
 * lines run to 497 points and one single feature measured 416 KB, which
 * is detail no 1024x600 kiosk can draw and no phone on a ferry wants to
 * download.
 *
 * Two steps, in this order:
 *
 *  1. Douglas-Peucker at `SIMPLIFY_TOLERANCE_DEGREES`, which discards a
 *     point only when the line drawn without it stays within the
 *     tolerance of where it was.
 *  2. Rounding to `COORDINATE_DECIMALS`, then dropping points that have
 *     become duplicates of their neighbour. Rounding after simplifying,
 *     not before: rounding first would quantise the very deviations the
 *     first step measures.
 *
 * Distances are computed in plain degree space, not on the sphere. At
 * Vesterålen's latitude a degree of longitude is about a third of a
 * degree of latitude on the ground, so the tolerance is in effect
 * *stricter* east-west than north-south -- it keeps more points than a
 * true metric tolerance would, never fewer. Erring toward keeping detail
 * is the right direction for a thing whose only job is to look like the
 * road it follows.
 */

/**
 * About 20 m of latitude. Chosen against what the display can resolve:
 * at the zoom levels this map uses, 20 m is well under a pixel, so no
 * discarded point was ever going to be visible.
 */
export const SIMPLIFY_TOLERANCE_DEGREES = 0.0002;

/**
 * Five decimals is about a metre -- an order of magnitude finer than the
 * tolerance above, so rounding can never undo a decision the
 * simplification made, while cutting the JSON for a coordinate pair
 * roughly in half against the 14 digits `JSON.stringify` would otherwise
 * emit.
 */
export const COORDINATE_DECIMALS = 5;

/** One `[lat, lng]` pair, already in Leaflet's order (the swap from the WFS's `[lng, lat]` happens in `situations.ts`, before this is called). */
export type LinePoint = [number, number];

const ROUNDING_FACTOR = 10 ** COORDINATE_DECIMALS;

function round(value: number): number {
    return Math.round(value * ROUNDING_FACTOR) / ROUNDING_FACTOR;
}

/**
 * Perpendicular distance from `point` to the segment `start`-`end`, in
 * degrees. A degenerate segment (both ends the same point, which real
 * road geometry does contain) falls back to the distance to that point,
 * which is what the limit of the formula gives anyway.
 */
function perpendicularDistance(point: LinePoint, start: LinePoint, end: LinePoint): number {
    const [py, px] = point;
    const [sy, sx] = start;
    const [ey, ex] = end;
    const dy = ey - sy;
    const dx = ex - sx;

    if (dx === 0 && dy === 0) return Math.hypot(py - sy, px - sx);

    // Twice the triangle's area over the base length: the classic
    // point-to-line distance, written without a division until the end so
    // a near-degenerate segment cannot blow up mid-expression.
    return Math.abs(dy * (px - sx) - dx * (py - sy)) / Math.hypot(dy, dx);
}

/**
 * Douglas-Peucker, iteratively rather than recursively: an upstream line
 * of several hundred points is shallow enough for recursion in practice,
 * but the depth is data-controlled and this is a public endpoint's input
 * path. An explicit stack takes that question off the table.
 */
function douglasPeucker(points: readonly LinePoint[], tolerance: number): LinePoint[] {
    if (points.length <= 2) return [...points];

    const keep = new Array<boolean>(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;

    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length > 0) {
        const segment = stack.pop();
        if (!segment) break;
        const [first, last] = segment;
        const start = points[first];
        const end = points[last];
        if (!start || !end) continue;

        let farthest = -1;
        let farthestDistance = 0;
        for (let index = first + 1; index < last; index += 1) {
            const candidate = points[index];
            if (!candidate) continue;
            const distance = perpendicularDistance(candidate, start, end);
            if (distance > farthestDistance) {
                farthestDistance = distance;
                farthest = index;
            }
        }

        if (farthest !== -1 && farthestDistance > tolerance) {
            keep[farthest] = true;
            stack.push([first, farthest], [farthest, last]);
        }
    }

    return points.filter((_point, index) => keep[index] === true);
}

/**
 * Simplifies and rounds one line. Endpoints always survive: a road
 * situation's extent is read as "from here to there", and moving either
 * end would misstate the thing the line is for.
 *
 * A line of two points or fewer is returned rounded but otherwise
 * untouched -- there is nothing in the middle to drop.
 */
export function simplifyLine(points: readonly LinePoint[], tolerance: number = SIMPLIFY_TOLERANCE_DEGREES): LinePoint[] {
    const simplified = douglasPeucker(points, tolerance);

    const rounded: LinePoint[] = [];
    for (const [lat, lng] of simplified) {
        const point: LinePoint = [round(lat), round(lng)];
        const previous = rounded[rounded.length - 1];
        // Rounding can collapse two kept points onto each other; a
        // repeated vertex draws nothing and costs bytes. If that happens
        // to every point -- a "line" a metre long -- what is left is a
        // single point, which is the honest rendering of it.
        if (previous?.[0] === point[0] && previous[1] === point[1]) continue;
        rounded.push(point);
    }

    return rounded;
}
