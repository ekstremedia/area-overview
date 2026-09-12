import { describe, expect, it } from 'vitest';
import { bboxCacheKey, clampBbox, parseBbox, roundBbox } from './bbox.js';

describe('parseBbox', () => {
    it('parses a valid "minLng,minLat,maxLng,maxLat" string', () => {
        const result = parseBbox('14.5,68.3,16.5,69.1');
        expect(result).toEqual({ ok: true, value: { minLng: 14.5, minLat: 68.3, maxLng: 16.5, maxLat: 69.1 } });
    });

    it('rejects a missing bbox', () => {
        expect(parseBbox(undefined).ok).toBe(false);
        expect(parseBbox('').ok).toBe(false);
    });

    it('rejects a bbox with the wrong number of parts', () => {
        expect(parseBbox('14.5,68.3,16.5').ok).toBe(false);
        expect(parseBbox('14.5,68.3,16.5,69.1,1').ok).toBe(false);
    });

    it('rejects non-numeric parts', () => {
        expect(parseBbox('a,68.3,16.5,69.1').ok).toBe(false);
    });

    it('rejects coordinates outside world bounds', () => {
        expect(parseBbox('14.5,68.3,16.5,999').ok).toBe(false);
        expect(parseBbox('-200,68.3,16.5,69.1').ok).toBe(false);
    });

    it('rejects a bbox where min is not less than max', () => {
        expect(parseBbox('16.5,68.3,14.5,69.1').ok).toBe(false); // minLng > maxLng
        expect(parseBbox('14.5,69.1,16.5,68.3').ok).toBe(false); // minLat > maxLat
        expect(parseBbox('14.5,68.3,14.5,69.1').ok).toBe(false); // minLng === maxLng
    });
});

describe('clampBbox', () => {
    it('leaves a bbox within the max span untouched', () => {
        const bbox = { minLat: 68.3, minLng: 14.5, maxLat: 69.1, maxLng: 16.5 };
        expect(clampBbox(bbox)).toEqual(bbox);
    });

    it('shrinks an oversized bbox around its own center rather than rejecting it', () => {
        const huge = { minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 };
        const clamped = clampBbox(huge);

        expect(clamped.maxLat - clamped.minLat).toBeLessThanOrEqual(2);
        expect(clamped.maxLng - clamped.minLng).toBeLessThanOrEqual(2);
        // Center is preserved.
        expect((clamped.minLat + clamped.maxLat) / 2).toBeCloseTo(0);
        expect((clamped.minLng + clamped.maxLng) / 2).toBeCloseTo(0);
    });

    it('re-clips to world bounds near a pole', () => {
        const nearPole = { minLat: 89, minLng: 10, maxLat: 89.5, maxLng: 12 };
        const clamped = clampBbox(nearPole);
        expect(clamped.maxLat).toBeLessThanOrEqual(90);
    });
});

describe('roundBbox', () => {
    it('snaps coordinates out to the 0.05° grid', () => {
        expect(roundBbox({ minLat: 68.301, minLng: 14.523, maxLat: 69.099, maxLng: 16.478 })).toEqual({
            minLat: 68.3,
            minLng: 14.5,
            maxLat: 69.1,
            maxLng: 16.5,
        });
    });

    it('never shrinks a bbox: every edge lands on or outside the one asked for', () => {
        const asked = { minLat: 68.34, minLng: 14.56, maxLat: 69.06, maxLng: 16.44 };
        const rounded = roundBbox(asked);

        // Rounding each edge to the *nearest* line used to pull three of
        // these four inward, so a vessel in the real viewport could be
        // outside the box actually queried.
        expect(rounded.minLat).toBeLessThanOrEqual(asked.minLat);
        expect(rounded.minLng).toBeLessThanOrEqual(asked.minLng);
        expect(rounded.maxLat).toBeGreaterThanOrEqual(asked.maxLat);
        expect(rounded.maxLng).toBeGreaterThanOrEqual(asked.maxLng);
    });

    it('keeps a zoomed-in viewport from collapsing to a point', () => {
        // The bug this exists to prevent: a viewport narrower than one grid
        // cell had both its edges rounded onto the same line, so the
        // upstream was asked for a rectangle with no area and the layer
        // went empty. A 600px-tall map reaches this at zoom 13 -- and the
        // map's own "zoom to this vessel" lands at 14, so a followed ship
        // vanished the moment it was followed.
        const tight = { minLat: 68.7616, minLng: 16.053, maxLat: 68.7736, maxLng: 16.073 };
        const rounded = roundBbox(tight);

        // `toBeCloseTo`, not `>=`: 68.80 - 68.75 is 0.04999999999999716 in
        // binary floating point, which is one grid cell by any measure
        // that matters.
        expect(rounded.maxLat - rounded.minLat).toBeCloseTo(0.05, 6);
        expect(rounded.maxLng - rounded.minLng).toBeCloseTo(0.05, 6);
        // And it still contains the ship that was dead centre of it.
        expect(rounded.minLat).toBeLessThan(68.76761);
        expect(rounded.maxLat).toBeGreaterThan(68.76761);
        expect(rounded.minLng).toBeLessThan(16.06304);
        expect(rounded.maxLng).toBeGreaterThan(16.06304);
    });

    it('leaves a bbox already on the grid exactly where it is', () => {
        // Floating-point noise in the cell quotient must not nudge an edge
        // out to the next line and quietly double the area queried.
        expect(roundBbox({ minLat: 68.3, minLng: 14.5, maxLat: 69.1, maxLng: 16.5 })).toEqual({
            minLat: 68.3,
            minLng: 14.5,
            maxLat: 69.1,
            maxLng: 16.5,
        });
    });

    it('produces the same cache key for two slightly different viewport bboxes from normal panning', () => {
        // Both land in the same grid cell on every edge, which is what a
        // pan of a few hundred metres looks like.
        const a = roundBbox({ minLat: 68.301, minLng: 14.523, maxLat: 69.099, maxLng: 16.478 });
        const b = roundBbox({ minLat: 68.318, minLng: 14.541, maxLat: 69.088, maxLng: 16.462 });

        expect(bboxCacheKey(a)).toBe(bboxCacheKey(b));
    });

    it('changes the cache key once an edge crosses a cell boundary', () => {
        // The trade-off of snapping outward rather than to the nearest
        // line: the boundaries sit in different places, so a pan that
        // straddles one is a fresh key. The rate is unchanged -- an edge
        // crosses a line just as often either way -- and correctness now
        // never depends on which side it landed.
        const inside = roundBbox({ minLat: 68.31, minLng: 14.52, maxLat: 69.09, maxLng: 16.47 });
        const across = roundBbox({ minLat: 68.29, minLng: 14.52, maxLat: 69.09, maxLng: 16.47 });

        expect(bboxCacheKey(inside)).not.toBe(bboxCacheKey(across));
    });

    it('produces a different cache key once a pan moves meaningfully', () => {
        const a = roundBbox({ minLat: 68.3, minLng: 14.5, maxLat: 69.1, maxLng: 16.5 });
        const b = roundBbox({ minLat: 70.3, minLng: 14.5, maxLat: 71.1, maxLng: 16.5 });

        expect(bboxCacheKey(a)).not.toBe(bboxCacheKey(b));
    });
});
