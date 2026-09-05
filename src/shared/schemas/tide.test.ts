import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/tide.json' with { type: 'json' };
import { TideSchema } from './tide.js';
import { omitKey } from './test-utils.js';

describe('TideSchema', () => {
    it('parses the recorded /api/tide fixture', () => {
        expect(() => TideSchema.parse(fixture)).not.toThrow();
    });

    it('rejects a fixture missing the required location field', () => {
        const withoutLocation = omitKey(fixture, 'location');
        const result = TideSchema.safeParse(withoutLocation);
        expect(result.success).toBe(false);
    });

    it('accepts a fixture with an extra unknown top-level field', () => {
        const result = TideSchema.safeParse({ ...fixture, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });

    it('accepts unmodelled upstream fields like predictionExtremes being stripped, not rejected', () => {
        const parsed = TideSchema.parse(fixture);
        expect(parsed).not.toHaveProperty('predictionExtremes');
    });

    it("parses the fixture's observedDeviation block", () => {
        const parsed = TideSchema.parse(fixture);
        expect(typeof parsed.observedDeviation?.value).toBe('number');
    });

    it('accepts a fixture with ocean omitted entirely (not every station has an ocean-forecast product)', () => {
        const withoutOcean = omitKey(fixture, 'ocean');
        const result = TideSchema.safeParse(withoutOcean);
        expect(result.success).toBe(true);
        expect(result.success && result.data.ocean).toBeUndefined();
    });
});
