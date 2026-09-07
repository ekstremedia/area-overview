import { describe, expect, it } from 'vitest';
import weatherFixture from '../fixtures/weather.json' with { type: 'json' };
import weatherNetatmoOfflineFixture from '../fixtures/weather-netatmo-offline.json' with { type: 'json' };
import summaryFixture from '../fixtures/weather-summary.json' with { type: 'json' };
import summaryEmptyFixture from '../fixtures/weather-summary-empty.json' with { type: 'json' };
import { WeatherSchema, WeatherSummaryResponseSchema, WeatherSummarySchema } from './weather.js';
import { omitKey } from './test-utils.js';

describe('WeatherSchema', () => {
    it('parses the recorded /api/weather fixture', () => {
        expect(() => WeatherSchema.parse(weatherFixture)).not.toThrow();
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

    // Regression: a real live GET /api/weather response against nesthus.no
    // (checked while building the daily forecast section) sends `null` --
    // not omitted -- for `periods.<part>.symbol_code`/`symbol_url`/
    // `precipitation` on far-future days/periods the upstream forecast
    // model has less confidence in. The fixture itself never has this
    // (all-populated, one specific real capture), so this constructs the
    // shape directly rather than relying on a fixture to happen to have it.
    it('parses a daily entry whose periods carry null symbol_code/symbol_url/precipitation', () => {
        const dailyWithNullPeriodFields = {
            ...weatherFixture,
            forecast: {
                ...weatherFixture.forecast,
                daily: [
                    {
                        date: '2026-09-14',
                        temperature_min: 8.9,
                        temperature_max: 12.5,
                        symbol_code: 'rain',
                        symbol_url: 'https://nesthus.no/vendor/laravel-yr/symbols/rain.svg',
                        periods: {
                            night: { symbol_code: null, symbol_url: null, precipitation: null },
                            morning: { symbol_code: null, symbol_url: null, precipitation: null },
                            afternoon: { symbol_code: null, symbol_url: null, precipitation: null },
                            evening: { symbol_code: null, symbol_url: null, precipitation: null },
                        },
                    },
                ],
            },
        };
        const result = WeatherSchema.safeParse(dailyWithNullPeriodFields);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.forecast.daily[0]?.periods?.night.symbol_code).toBeNull();
        }
    });

    it('parses a daily entry with a fully populated periods object (night/morning/afternoon/evening, each with a symbol_url)', () => {
        const result = WeatherSchema.safeParse(weatherFixture);
        expect(result.success).toBe(true);
        if (result.success) {
            const [firstDay] = result.data.forecast.daily;
            expect(firstDay?.periods?.night.symbol_url).toBe('https://nesthus.no/vendor/laravel-yr/symbols/partlycloudy_night.svg');
            expect(firstDay?.periods?.afternoon.symbol_url).toBe('https://nesthus.no/vendor/laravel-yr/symbols/fair_day.svg');
        }
    });

    it('parses the netatmo-offline fixture whose daily entries omit periods entirely', () => {
        const result = WeatherSchema.safeParse(weatherNetatmoOfflineFixture);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.forecast.daily[0]?.periods).toBeUndefined();
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
