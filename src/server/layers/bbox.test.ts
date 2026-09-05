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
    it('rounds coordinates to the 0.05° grid', () => {
        expect(roundBbox({ minLat: 68.301, minLng: 14.523, maxLat: 69.099, maxLng: 16.478 })).toEqual({
            minLat: 68.3,
            minLng: 14.5,
            maxLat: 69.1,
            maxLng: 16.5,
        });
    });

    it('produces the same cache key for two slightly different viewport bboxes from normal panning', () => {
        const a = roundBbox({ minLat: 68.301, minLng: 14.523, maxLat: 69.099, maxLng: 16.478 });
        const b = roundBbox({ minLat: 68.318, minLng: 14.489, maxLat: 69.112, maxLng: 16.501 });

        expect(bboxCacheKey(a)).toBe(bboxCacheKey(b));
    });

    it('produces a different cache key once a pan moves meaningfully', () => {
        const a = roundBbox({ minLat: 68.3, minLng: 14.5, maxLat: 69.1, maxLng: 16.5 });
        const b = roundBbox({ minLat: 70.3, minLng: 14.5, maxLat: 71.1, maxLng: 16.5 });

        expect(bboxCacheKey(a)).not.toBe(bboxCacheKey(b));
    });
});
