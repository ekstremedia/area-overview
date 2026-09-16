/**
 * Direct tests for the Sutherland-Hodgman clip and centroid math shared by
 * `regions.ts` and `met-alerts.ts` -- previously covered only indirectly,
 * through `regions.test.ts`/`met-alerts.test.ts`'s own fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { Bbox } from '../layers/bbox.js';
import { clipRingToBbox, ringCentroid, ringIntersectsBbox, type Ring } from './geo.js';

/** A 2x2 square, `[lat, lng]`, `(0,0)` to `(2,2)`. */
const SQUARE: Ring = [
    [0, 0],
    [0, 2],
    [2, 2],
    [2, 0],
];

/** An L-shaped concave ring: the union of a `0<=lat<=1, 0<=lng<=3` bar and a `0<=lat<=3, 0<=lng<=1` bar, leaving the `lat>1, lng>1` corner (up to `3,3`) as a notch outside the ring. */
const L_SHAPE: Ring = [
    [0, 0],
    [0, 3],
    [1, 3],
    [1, 1],
    [3, 1],
    [3, 0],
];

describe('clipRingToBbox / ringIntersectsBbox', () => {
    it('returns the polygon unchanged when it sits fully inside the bbox (no clipping needed)', () => {
        const bbox: Bbox = { minLat: -10, minLng: -10, maxLat: 10, maxLng: 10 };

        const clipped = clipRingToBbox(SQUARE, bbox);

        expect(clipped).toHaveLength(4);
        expect(ringIntersectsBbox(SQUARE, bbox)).toBe(true);
        expect(ringCentroid(clipped)).toEqual({ lat: 1, lng: 1 });
    });

    it('finds the intersection when the bbox sits fully inside the region polygon', () => {
        const bigSquare: Ring = [
            [-10, -10],
            [-10, 10],
            [10, 10],
            [10, -10],
        ];
        const bbox: Bbox = { minLat: 0, minLng: 0, maxLat: 2, maxLng: 2 };

        const clipped = clipRingToBbox(bigSquare, bbox);

        expect(ringIntersectsBbox(bigSquare, bbox)).toBe(true);
        expect(ringCentroid(clipped)).toEqual({ lat: 1, lng: 1 });
    });

    it('does NOT count a bare edge-touch (bbox sharing exactly one boundary line with the region) as an intersection', () => {
        // SQUARE's right edge is lng=2. This bbox sits immediately to its
        // right, sharing that one line but no area.
        const bbox: Bbox = { minLat: 0, minLng: 2, maxLat: 2, maxLng: 4 };

        const clipped = clipRingToBbox(SQUARE, bbox);

        // The clip still yields collinear points along the shared edge --
        // a naive point-count check would wrongly call this "intersecting".
        expect(clipped.length).toBeGreaterThanOrEqual(2);
        expect(ringIntersectsBbox(SQUARE, bbox)).toBe(false);
    });

    it('does NOT count a corner-only touch as an intersection', () => {
        // SQUARE's top-right corner is (2,2). This bbox touches only that
        // single point.
        const bbox: Bbox = { minLat: 2, minLng: 2, maxLat: 4, maxLng: 4 };

        expect(ringIntersectsBbox(SQUARE, bbox)).toBe(false);
    });

    it('clips a concave subject ring correctly -- a bbox inside the notch does not intersect', () => {
        const notchBbox: Bbox = { minLat: 1.5, minLng: 1.5, maxLat: 2.5, maxLng: 2.5 };

        expect(ringIntersectsBbox(L_SHAPE, notchBbox)).toBe(false);
    });

    it('clips a concave subject ring correctly -- a bbox inside one arm does intersect', () => {
        const armBbox: Bbox = { minLat: 0, minLng: 0, maxLat: 0.5, maxLng: 0.5 };

        expect(ringIntersectsBbox(L_SHAPE, armBbox)).toBe(true);
        const clipped = clipRingToBbox(L_SHAPE, armBbox);
        // Fully inside one arm: the clip is the bbox rectangle itself.
        expect(ringCentroid(clipped)).toEqual({ lat: 0.25, lng: 0.25 });
    });
});

describe('ringCentroid', () => {
    it('falls back to the plain vertex average for a near-zero-area (collinear) ring', () => {
        const collinear: Ring = [
            [0, 0],
            [0, 2],
            [0, 4],
        ];

        expect(ringCentroid(collinear)).toEqual({ lat: 0, lng: 2 });
    });
});
