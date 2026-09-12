import { describe, expect, it } from 'vitest';
import { parsePointQuery, pointCacheKey, roundPoint, samePoint } from './point.js';

function pointOf(result: ReturnType<typeof parsePointQuery>): { lat: number; lng: number } | null {
    if (!result.ok) throw new Error(`expected a point, got error: ${result.error.message}`);
    return result.value;
}

describe('parsePointQuery', () => {
    it('rounds an incoming position to two decimals, for the cache key and the upstream call alike', () => {
        expect(pointOf(parsePointQuery({ lat: '59.9139', lng: '10.7522' }))).toEqual({ lat: 59.91, lng: 10.75 });
    });

    it('accepts numbers as well as strings', () => {
        expect(pointOf(parsePointQuery({ lat: 59.91, lng: 10.75 }))).toEqual({ lat: 59.91, lng: 10.75 });
    });

    it('reads no coordinates as the home position, which is what keeps every ordinary visitor on one cache key', () => {
        expect(pointOf(parsePointQuery({}))).toBeNull();
        expect(pointOf(parsePointQuery(undefined))).toBeNull();
        expect(pointOf(parsePointQuery({ lat: '', lng: '' }))).toBeNull();
    });

    it('rejects half a position rather than quietly treating it as none', () => {
        // This is exactly what the `lon`-versus-`lng` mistake looks like
        // from here: the upstream silently ignores `lon` and answers for
        // Sortland, so a client bug would become a wrong answer nobody
        // notices.
        expect(parsePointQuery({ lat: '59.91' }).ok).toBe(false);
        expect(parsePointQuery({ lng: '10.75' }).ok).toBe(false);
        expect(parsePointQuery({ lat: '59.91', lon: '10.75' }).ok).toBe(false);
    });

    it('rejects coordinates outside the world', () => {
        expect(parsePointQuery({ lat: '91', lng: '0' }).ok).toBe(false);
        expect(parsePointQuery({ lat: '-91', lng: '0' }).ok).toBe(false);
        expect(parsePointQuery({ lat: '0', lng: '181' }).ok).toBe(false);
        expect(parsePointQuery({ lat: '0', lng: '-181' }).ok).toBe(false);
    });

    it('rejects values that are not numbers at all', () => {
        expect(parsePointQuery({ lat: 'abc', lng: '10.75' }).ok).toBe(false);
        expect(parsePointQuery({ lat: 'NaN', lng: '10.75' }).ok).toBe(false);
        expect(parsePointQuery({ lat: 'Infinity', lng: '10.75' }).ok).toBe(false);
        expect(parsePointQuery({ lat: { nested: 1 }, lng: '10.75' }).ok).toBe(false);
    });

    it('accepts the edges of the world', () => {
        expect(parsePointQuery({ lat: '90', lng: '180' }).ok).toBe(true);
        expect(parsePointQuery({ lat: '-90', lng: '-180' }).ok).toBe(true);
    });
});

describe('roundPoint', () => {
    it('rounds both coordinates, negatives included', () => {
        expect(roundPoint({ lat: 40.4168, lng: -3.7038 })).toEqual({ lat: 40.42, lng: -3.7 });
    });
});

describe('samePoint', () => {
    it('matches a stored four-decimal home view against a two-decimal query', () => {
        // `settings.homeView` holds 68.6984/15.4129; a located query
        // arrives as 68.70/15.41. Rounding both sides is what makes the
        // Netatmo gate's "is this the home position?" check work at all.
        expect(samePoint({ lat: 68.6984, lng: 15.4129 }, { lat: 68.7, lng: 15.41 })).toBe(true);
    });

    it('separates genuinely different places', () => {
        expect(samePoint({ lat: 68.6984, lng: 15.4129 }, { lat: 59.91, lng: 10.75 })).toBe(false);
    });

    it('separates neighbouring points that round differently', () => {
        expect(samePoint({ lat: 59.914, lng: 10.75 }, { lat: 59.925, lng: 10.75 })).toBe(false);
    });
});

describe('pointCacheKey', () => {
    it('names the home position plainly, so a log line reads', () => {
        expect(pointCacheKey(null)).toBe('home');
    });

    it('is stable across equivalent spellings of the same point', () => {
        expect(pointCacheKey({ lat: 59.91, lng: 10.75 })).toBe(pointCacheKey({ lat: 59.9139, lng: 10.7522 }));
    });

    it('keeps trailing zeros, so 59.9 and 59.90 are one key rather than two', () => {
        expect(pointCacheKey({ lat: 59.9, lng: 10.7 })).toBe('59.90,10.70');
    });

    it('distinguishes different points', () => {
        expect(pointCacheKey({ lat: 59.91, lng: 10.75 })).not.toBe(pointCacheKey({ lat: 68.7, lng: 15.41 }));
    });
});
