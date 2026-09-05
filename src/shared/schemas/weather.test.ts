import { describe, expect, it } from 'vitest';
import weatherFixture from '../fixtures/weather.json' with { type: 'json' };
import weatherNetatmoOfflineFixture from '../fixtures/weather-netatmo-offline.json' with { type: 'json' };
import weatherPointFixture from '../fixtures/weather-point.json' with { type: 'json' };
import summaryFixture from '../fixtures/weather-summary.json' with { type: 'json' };
import summaryEmptyFixture from '../fixtures/weather-summary-empty.json' with { type: 'json' };
import { WeatherSchema, WeatherSummaryResponseSchema, WeatherSummarySchema } from './weather.js';
import { omitKey } from './test-utils.js';

describe('WeatherSchema', () => {
    it('parses the recorded /api/weather fixture', () => {
        expect(() => WeatherSchema.parse(weatherFixture)).not.toThrow();
    });

    it('parses the recorded /api/weather?lat&lng point-forecast fixture', () => {
        expect(() => WeatherSchema.parse(weatherPointFixture)).not.toThrow();
    });

    it('rejects a fixture missing the required location field', () => {
        const withoutLocation = omitKey(weatherFixture, 'location');
        const result = WeatherSchema.safeParse(withoutLocation);
        expect(result.success).toBe(false);
    });

    it('accepts a fixture with an extra unknown top-level field', () => {
        const result = WeatherSchema.safeParse({ ...weatherFixture, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });

    // Regression: the real production upstream sends `netatmo: null` and
    // omits `current.rain.{current,last_hour,last_24h}` entirely when
    // Terje's home Netatmo station is offline/unreachable -- a real,
    // expected degraded-but-valid state that must parse, not a 502.
    it('parses the recorded fixture captured while the Netatmo station was offline (netatmo: null, rain fields absent)', () => {
        const result = WeatherSchema.safeParse(weatherNetatmoOfflineFixture);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.netatmo).toBeNull();
            expect(result.data.current.rain.current).toBeUndefined();
            expect(result.data.current.rain.last_hour).toBeUndefined();
            expect(result.data.current.rain.last_24h).toBeUndefined();
        }
    });
});

describe('WeatherSummarySchema', () => {
    it('parses the recorded summary fixture', () => {
        expect(() => WeatherSummarySchema.parse(summaryFixture)).not.toThrow();
    });

    it('rejects a summary fixture missing the required model field', () => {
        const withoutModel = omitKey(summaryFixture, 'model');
        const result = WeatherSummarySchema.safeParse(withoutModel);
        expect(result.success).toBe(false);
    });

    it('accepts a summary fixture with an extra unknown field', () => {
        const result = WeatherSummarySchema.safeParse({ ...summaryFixture, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });
});

describe('WeatherSummaryResponseSchema', () => {
    it('accepts a populated summary', () => {
        expect(WeatherSummaryResponseSchema.safeParse(summaryFixture).success).toBe(true);
    });

    it('accepts the synthetic empty-summary (HTTP 204) shape', () => {
        expect(WeatherSummaryResponseSchema.safeParse(summaryEmptyFixture).success).toBe(true);
    });

    it('rejects a summary: undefined instead of summary: null', () => {
        expect(WeatherSummaryResponseSchema.safeParse({}).success).toBe(false);
    });
});
