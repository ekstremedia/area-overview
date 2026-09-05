import { describe, expect, it } from 'vitest';
import { IsoTimestampSchema, LatLngSchema } from './common.js';
import { omitKey } from './test-utils.js';

describe('LatLngSchema', () => {
    const valid = { lat: 68.6984, lng: 15.4129 };

    it('parses a valid point', () => {
        expect(LatLngSchema.parse(valid)).toEqual(valid);
    });

    it('rejects a point missing lat', () => {
        const withoutLat = omitKey(valid, 'lat');
        const result = LatLngSchema.safeParse(withoutLat);
        expect(result.success).toBe(false);
    });

    it('accepts an unknown extra field', () => {
        const result = LatLngSchema.safeParse({ ...valid, extra: 'field' });
        expect(result.success).toBe(true);
    });

    it('rejects out-of-range latitude and longitude', () => {
        expect(LatLngSchema.safeParse({ lat: 91, lng: 0 }).success).toBe(false);
        expect(LatLngSchema.safeParse({ lat: 0, lng: 181 }).success).toBe(false);
    });
});

describe('IsoTimestampSchema', () => {
    it('parses a valid ISO-8601 string', () => {
        expect(IsoTimestampSchema.parse('2026-09-05T01:00:06.369580Z')).toBe('2026-09-05T01:00:06.369580Z');
    });

    it('rejects a non-parseable string', () => {
        expect(IsoTimestampSchema.safeParse('not a timestamp').success).toBe(false);
    });
});
