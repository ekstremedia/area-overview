import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeatherSchema, WeatherSummaryResponseSchema } from '../../shared/schemas/weather.js';
import weatherFixture from '../../shared/fixtures/weather.json' with { type: 'json' };
import weatherPointFixture from '../../shared/fixtures/weather-point.json' with { type: 'json' };
import weatherSummaryFixture from '../../shared/fixtures/weather-summary.json' with { type: 'json' };
import weatherSummaryEmptyFixture from '../../shared/fixtures/weather-summary-empty.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

// `WeatherSchema`/`WeatherSummaryResponseSchema` strip fields they don't
// model (e.g. the daily forecast's `periods`/`steps`), so the route's JSON
// response is the *parsed*, not the raw, fixture -- compare against that.
const expectedWeather = WeatherSchema.parse(weatherFixture);
const expectedWeatherPoint = WeatherSchema.parse(weatherPointFixture);
const expectedSummary = WeatherSummaryResponseSchema.parse(weatherSummaryFixture);
const expectedEmptySummary = WeatherSummaryResponseSchema.parse(weatherSummaryEmptyFixture);

describe('GET /api/weather', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the validated default weather on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/weather' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(expectedWeather);
        expect(response.headers.etag).toBeDefined();
    });

    it('rounds lat/lng to two decimals and returns the point forecast', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherPointFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/weather?lat=68.711&lng=15.399' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(expectedWeatherPoint);
        const [calledUrl] = fetchMock.mock.calls[0] as [string];
        expect(calledUrl).toBe('https://upstream.example/api/weather?lat=68.71&lng=15.4');
    });

    it('responds 400 for an out-of-range latitude', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/weather?lat=999&lng=15.4' });

        expect(response.statusCode).toBe(400);
    });

    it('responds 502 on a cold cache when upstream is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/weather' });

        expect(response.statusCode).toBe(502);
    });

    it('serves the stale cached value with X-Cache: stale when upstream later fails', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ cacheTtlMs: 10 });

        const warm = await app.inject({ method: 'GET', url: '/api/weather' });
        expect(warm.statusCode).toBe(200);

        await sleep(20);
        fetchMock.mockRejectedValue(new Error('network down'));

        const stale = await app.inject({ method: 'GET', url: '/api/weather' });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
    });

    it('single-flights concurrent requests into one upstream call', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        const [first, second] = await Promise.all([
            app.inject({ method: 'GET', url: '/api/weather' }),
            app.inject({ method: 'GET', url: '/api/weather' }),
        ]);

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('GET /api/weather/summary', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the validated summary when one exists', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherSummaryFixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/weather/summary' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(expectedSummary);
    });

    it('responds 200 with a null summary when upstream answers 204', async () => {
        // A real 204 has no body at all -- `jsonResponse` models that by
        // discarding whatever body is passed for a null-body status.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(null, 204)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/weather/summary' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(expectedEmptySummary);
    });
});
