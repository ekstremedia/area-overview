import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeatherSchema, WeatherSummaryResponseSchema } from '../../shared/schemas/weather.js';
import weatherFixture from '../../shared/fixtures/weather.json' with { type: 'json' };
import weatherSummaryFixture from '../../shared/fixtures/weather-summary.json' with { type: 'json' };
import weatherSummaryEmptyFixture from '../../shared/fixtures/weather-summary-empty.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

// `WeatherSchema`/`WeatherSummaryResponseSchema` strip fields they don't
// model (e.g. the daily forecast's `periods`/`steps`), so the route's JSON
// response is the *parsed*, not the raw, fixture -- compare against that.
const expectedWeather = WeatherSchema.parse(weatherFixture);
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

describe('GET /api/weather -- by position', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('forwards the position to the upstream as lng, never lon', async () => {
        // Pinned deliberately, and asserted on the exact URL: the upstream
        // silently IGNORES `lon` and answers for Sortland rather than
        // erroring, so this spelling mistake would ship as "the position
        // feature doesn't work" with nothing in any log to explain it.
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: '/api/weather?lat=59.91&lng=10.75' });

        const url = String(fetchMock.mock.calls[0]?.[0]);
        expect(url).toContain('lat=59.91');
        expect(url).toContain('lng=10.75');
        expect(url).not.toContain('lon=');
    });

    it('rounds the position before it reaches the upstream at all', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: '/api/weather?lat=59.913869&lng=10.752245' });

        const url = String(fetchMock.mock.calls[0]?.[0]);
        expect(url).toContain('lat=59.91');
        expect(url).not.toContain('59.913869');
    });

    it('sends no coordinates at all for the home position, so the kiosk keeps its existing URL', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: '/api/weather' });

        expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('lat=');
    });

    it('serves two requests for one point from a single upstream call', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: '/api/weather?lat=59.91&lng=10.75' });
        await app.inject({ method: 'GET', url: '/api/weather?lat=59.9139&lng=10.7522' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fetches separately for genuinely different points', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(weatherFixture)));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: '/api/weather?lat=59.91&lng=10.75' });
        await app.inject({ method: 'GET', url: '/api/weather?lat=68.70&lng=15.41' });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the home position on its own short-lived cache, not the point cache', async () => {
        // A fresh Response per call: a body can only be read once, and
        // this test is the one that genuinely fetches twice.
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(weatherFixture)));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ cacheTtlMs: 30_000, pointForecastTtlMs: 600_000 });

        const home = await app.inject({ method: 'GET', url: '/api/weather' });
        const point = await app.inject({ method: 'GET', url: '/api/weather?lat=59.91&lng=10.75' });

        expect(home.statusCode).toBe(200);
        expect(point.statusCode).toBe(200);

        // Each advertises its own TTL: the kiosk's own view must not
        // inherit ten minutes of staleness from a visitor's.
        expect(home.headers['cache-control']).toContain('max-age=30');
        expect(point.headers['cache-control']).toContain('max-age=600');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects half a position with 400 rather than answering for somewhere else', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/weather?lat=59.91' });

        expect(response.statusCode).toBe(400);
    });

    it('rejects coordinates outside the world', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const app = buildTestApp();

        expect((await app.inject({ method: 'GET', url: '/api/weather?lat=91&lng=0' })).statusCode).toBe(400);
        expect((await app.inject({ method: 'GET', url: '/api/weather?lat=0&lng=-181' })).statusCode).toBe(400);
    });
});
