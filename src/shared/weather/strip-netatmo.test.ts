import { describe, expect, it } from 'vitest';
import offlineFixture from '../fixtures/weather-netatmo-offline.json' with { type: 'json' };
import weatherFixture from '../fixtures/weather.json' with { type: 'json' };
import { WeatherSchema } from '../schemas/weather.js';
import { stripNetatmo } from './strip-netatmo.js';

function requireStripped(weather: ReturnType<typeof stripNetatmo>): NonNullable<ReturnType<typeof stripNetatmo>> {
    if (!weather) throw new Error('expected a stripped document');
    return weather;
}

describe('stripNetatmo', () => {
    it('is a no-op on a real response captured while the station was genuinely offline', () => {
        // The strong contract: whatever upstream itself produces when
        // Netatmo is down is exactly what this must produce when it is up.
        // Every detail of a Yr-only `current` is pinned by this one
        // assertion -- the km/h wind conversion, the reduced `rain`, the
        // absent min/max/trend, the missing `gust_direction`.
        const offline = WeatherSchema.parse(offlineFixture);

        expect(requireStripped(stripNetatmo(offline))).toEqual(offline);
    });

    it('removes the station block entirely', () => {
        const stripped = requireStripped(stripNetatmo(WeatherSchema.parse(weatherFixture)));

        expect(stripped.netatmo).toBeNull();
    });

    it('marks every current reading as coming from Yr', () => {
        const stripped = requireStripped(stripNetatmo(WeatherSchema.parse(weatherFixture)));

        expect(stripped.current.temperature.source).toBe('yr');
        expect(stripped.current.humidity.source).toBe('yr');
        expect(stripped.current.pressure.source).toBe('yr');
        expect(stripped.current.wind.source).toBe('yr');
        expect(stripped.current.rain.source).toBe('yr');
        expect(stripped.current.conditions.source).toBe('yr');
    });

    it('takes the temperature from Yr rather than from the station', () => {
        const parsed = WeatherSchema.parse(weatherFixture);
        const stripped = requireStripped(stripNetatmo(parsed));

        const yrTemperature = (parsed.yr as { current: { temperature: number } }).current.temperature;
        expect(stripped.current.temperature.value).toBe(yrTemperature);
        expect(stripped.current.temperature.value).not.toBe(parsed.current.temperature.value);
    });

    it('converts wind from m/s to km/h, as upstream does', () => {
        // Missing this would under-report wind by a factor of 3.6 --
        // a gale rendered as a breeze, with nothing to show it was wrong.
        const parsed = WeatherSchema.parse(weatherFixture);
        const stripped = requireStripped(stripNetatmo(parsed));

        const yrWind = (parsed.yr as { current: { wind_speed: number } }).current.wind_speed;
        expect(stripped.current.wind.speed).toBeCloseTo(yrWind * 3.6, 5);
    });

    it('drops the station-derived min, max and trend', () => {
        const parsed = WeatherSchema.parse(weatherFixture);
        expect(parsed.current.temperature.min).toBeDefined(); // present before

        const stripped = requireStripped(stripNetatmo(parsed));

        expect(stripped.current.temperature.min).toBeUndefined();
        expect(stripped.current.temperature.max).toBeUndefined();
        expect(stripped.current.temperature.trend).toBeUndefined();
        expect(stripped.current.pressure.trend).toBeUndefined();
    });

    it('reduces rain to nothing but its source, since the gauge is the station', () => {
        const parsed = WeatherSchema.parse(weatherFixture);
        expect(parsed.current.rain.last_24h).toBeDefined(); // present before

        const stripped = requireStripped(stripNetatmo(parsed));

        expect(stripped.current.rain).toEqual({ source: 'yr' });
    });

    it('leaves the forecast, sun, moon and attribution alone', () => {
        const parsed = WeatherSchema.parse(weatherFixture);
        const stripped = requireStripped(stripNetatmo(parsed));

        expect(stripped.forecast).toEqual(parsed.forecast);
        expect(stripped.sun).toEqual(parsed.sun);
        expect(stripped.moon).toEqual(parsed.moon);
        expect(stripped.attribution).toEqual(parsed.attribution);
    });

    it('fails closed when yr.current cannot be read', () => {
        // The caller must 502 rather than serve the original: returning
        // the untouched document would leak exactly what this removes.
        const parsed = WeatherSchema.parse(weatherFixture);

        expect(stripNetatmo({ ...parsed, yr: {} })).toBeNull();
        expect(stripNetatmo({ ...parsed, yr: { current: { temperature: 'warm' } } })).toBeNull();
    });

    it('still parses as a valid weather document afterwards', () => {
        const stripped = requireStripped(stripNetatmo(WeatherSchema.parse(weatherFixture)));

        expect(WeatherSchema.safeParse(stripped).success).toBe(true);
    });
});
