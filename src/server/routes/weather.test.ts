import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeatherSchema, WeatherSummaryResponseSchema } from '../../shared/schemas/weather.js';
import weatherFixture from '../../shared/fixtures/weather.json' with { type: 'json' };
import weatherSummaryFixture from '../../shared/fixtures/weather-summary.json' with { type: 'json' };
import weatherSummaryEmptyFixture from '../../shared/fixtures/weather-summary-empty.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Matches `testConfig`'s own `settingsPassword` -- the Netatmo gate reads it. */
const SETTINGS_PASSWORD = 'test-password-at-least-16-chars';

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

    it('returns the validated default weather, Netatmo included, to a device holding the password', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const app = buildTestApp({}, { settingsAuthFailureDelayMs: 5 });

        const response = await app.inject({
            method: 'GET',
            url: '/api/weather',
            headers: { authorization: `Bearer ${SETTINGS_PASSWORD}` },
        });

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

describe('GET /api/weather -- the Netatmo gate', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const authorized = { authorization: `Bearer ${SETTINGS_PASSWORD}` };

    function app() {
        return buildTestApp({}, { settingsAuthFailureDelayMs: 5 });
    }

    /** Parsed rather than read raw: it keeps the assertions typed, and proves the gated response is still a valid weather document. */
    function weatherOf(response: { json: () => unknown }) {
        return WeatherSchema.parse(response.json());
    }

    it('serves Yr-only readings to a visitor with no password', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));

        const response = await app().inject({ method: 'GET', url: '/api/weather' });

        const body = weatherOf(response);
        expect(body.netatmo).toBeNull();
        expect(body.current.temperature.source).toBe('yr');
        expect(body.current.rain).toEqual({ source: 'yr' });
    });

    it('includes the station for a device holding the password, at the home position', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));

        const response = await app().inject({ method: 'GET', url: '/api/weather', headers: authorized });

        expect(weatherOf(response).netatmo).not.toBeNull();
        expect(weatherOf(response).current.temperature.source).toBe('netatmo');
    });

    it('includes the station when the position given IS the home position', async () => {
        // `homeView` is 68.6984/15.4129 and the query rounds to
        // 68.70/15.41 -- rounding both sides is what makes this match.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));

        const response = await app().inject({ method: 'GET', url: '/api/weather?lat=68.6984&lng=15.4129', headers: authorized });

        expect(weatherOf(response).netatmo).not.toBeNull();
    });

    it('withholds the station for a foreign position even with the password', async () => {
        // A temperature measured in Sortland attached to a forecast for
        // Oslo would be wrong as well as private, and the upstream merges
        // it in regardless of the coordinates it is given.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));

        const response = await app().inject({ method: 'GET', url: '/api/weather?lat=59.91&lng=10.75', headers: authorized });

        expect(weatherOf(response).netatmo).toBeNull();
        expect(weatherOf(response).current.temperature.source).toBe('yr');
    });

    it('withholds the station for everyone when the setting is off', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        // Its own settings file: `testConfig`'s default path is a
        // module-level constant shared by every `buildTestApp` in the run,
        // so a PATCH here would otherwise flip `useNetatmo` for every test
        // that follows it in this file.
        const instance = buildTestApp(
            { settingsFile: path.join(tmpdir(), `area-overview-netatmo-gate-${randomUUID()}.json`) },
            { settingsAuthFailureDelayMs: 5 },
        );
        await instance.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { ...authorized, 'content-type': 'application/json' },
            payload: { weather: { useNetatmo: false } },
        });

        const response = await instance.inject({ method: 'GET', url: '/api/weather', headers: authorized });

        expect(weatherOf(response).netatmo).toBeNull();
    });

    it('serves both variants from a single upstream call, with different ETags', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(weatherFixture)));
        vi.stubGlobal('fetch', fetchMock);
        const instance = app();

        const open = await instance.inject({ method: 'GET', url: '/api/weather' });
        const locked = await instance.inject({ method: 'GET', url: '/api/weather', headers: authorized });

        const upstreamCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/weather'));
        expect(upstreamCalls).toHaveLength(1);
        expect(open.headers.etag).not.toBe(locked.headers.etag);
    });

    it('tells caches the body depends on the credentials, and not to share an authorised one', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const instance = app();

        const open = await instance.inject({ method: 'GET', url: '/api/weather' });
        const locked = await instance.inject({ method: 'GET', url: '/api/weather', headers: authorized });

        expect(open.headers.vary).toBe('Authorization');
        expect(locked.headers.vary).toBe('Authorization');
        expect(open.headers['cache-control']).toContain('public');
        expect(locked.headers['cache-control']).toContain('private');
    });

    it('keeps the station out of the stale fallback too, not just the fresh response', async () => {
        // The cache holds the raw upstream document, so the stale path
        // would otherwise serve exactly what the gate exists to withhold
        // -- for the whole duration of an upstream outage.
        const fetchMock = vi.fn().mockImplementationOnce(() => Promise.resolve(jsonResponse(weatherFixture)));
        vi.stubGlobal('fetch', fetchMock);
        const instance = buildTestApp({ cacheTtlMs: 10 }, { settingsAuthFailureDelayMs: 5 });

        await instance.inject({ method: 'GET', url: '/api/weather' });
        await sleep(20);
        fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));

        const stale = await instance.inject({ method: 'GET', url: '/api/weather' });

        expect(stale.headers['x-cache']).toBe('stale');
        expect(weatherOf(stale).netatmo).toBeNull();
        expect(weatherOf(stale).current.temperature.source).toBe('yr');
    });

    it('fails closed rather than serving the station when yr.current is unreadable', async () => {
        // If upstream ever moves `yr.current`, the strip cannot be
        // performed -- and serving the original would leak the station.
        const broken = { ...weatherFixture, yr: {} };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(broken)));

        const response = await app().inject({ method: 'GET', url: '/api/weather' });

        expect(response.statusCode).toBe(502);
        expect(response.body).not.toContain('netatmo');
    });

    it('costs a wrong password the same delay here as at the login route', async () => {
        // Otherwise this becomes a faster password oracle than the route
        // that is actually guarded, and the 1s cost there buys nothing.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const instance = buildTestApp({}, { settingsAuthFailureDelayMs: 120 });

        const started = Date.now();
        const response = await instance.inject({ method: 'GET', url: '/api/weather', headers: { authorization: 'Bearer wrong-password' } });

        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
        expect(weatherOf(response).netatmo).toBeNull();
    });

    it('costs an absent header nothing at all, since it is not a guess', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const instance = buildTestApp({}, { settingsAuthFailureDelayMs: 2000 });

        const started = Date.now();
        await instance.inject({ method: 'GET', url: '/api/weather' });

        expect(Date.now() - started).toBeLessThan(1000);
    });
});
