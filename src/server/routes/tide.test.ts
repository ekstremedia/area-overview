import { afterEach, describe, expect, it, vi } from 'vitest';
import { TideSchema } from '../../shared/schemas/tide.js';
import tideFixture from '../../shared/fixtures/tide.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

// `TideSchema` strips fields it doesn't model (e.g.
// `predictionExtremes`/`forecastExtremes`), so the route's JSON response is
// the *parsed*, not the raw, fixture -- compare against that.
const expectedTide = TideSchema.parse(tideFixture);

describe('GET /api/tide', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the validated tide data on success', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tideFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/tide' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(expectedTide);
        expect(response.headers.etag).toBeDefined();
        const [calledUrl] = fetchMock.mock.calls[0] as [string];
        expect(calledUrl).toBe('https://upstream.example/api/tide?timespan=24h');
    });

    it('responds 502 on a cold cache when upstream is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/tide' });

        expect(response.statusCode).toBe(502);
    });

    it('serves the stale cached value with X-Cache: stale when upstream later fails', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tideFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ cacheTtlMs: 10 });

        const warm = await app.inject({ method: 'GET', url: '/api/tide' });
        expect(warm.statusCode).toBe(200);

        await sleep(20);
        fetchMock.mockRejectedValue(new Error('network down'));

        const stale = await app.inject({ method: 'GET', url: '/api/tide' });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
    });

    it('single-flights concurrent requests into one upstream call', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tideFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        const [first, second] = await Promise.all([app.inject({ method: 'GET', url: '/api/tide' }), app.inject({ method: 'GET', url: '/api/tide' })]);

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('GET /api/tide -- by position', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('forwards the position as lng (never lon) while keeping timespan=24h', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(tideFixture)));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: '/api/tide?lat=59.91&lng=10.75' });

        const url = String(fetchMock.mock.calls[0]?.[0]);
        expect(url).toContain('timespan=24h');
        expect(url).toContain('lat=59.91');
        expect(url).toContain('lng=10.75');
        expect(url).not.toContain('lon=');
    });

    it('sends no coordinates for the home position', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(tideFixture)));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: '/api/tide' });

        expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('lat=');
    });

    it('rejects half a position', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(tideFixture))),
        );
        const app = buildTestApp();

        expect((await app.inject({ method: 'GET', url: '/api/tide?lng=10.75' })).statusCode).toBe(400);
    });

    it('passes through a position with no tide station rather than failing on it', async () => {
        // What the live upstream returns for somewhere inland abroad: HTTP
        // 200, everything null, empty series -- and, unhelpfully, the name
        // "Sortland". A stricter schema would turn this valid degraded
        // answer into a 502, which is the mistake `weather.ts` already
        // records having made once with Netatmo.
        const noStation = {
            ...tideFixture,
            location: { name: 'Sortland', latitude: 40.41, longitude: -3.7, code: null },
            timeseries: [],
            extremes: [],
            nextHighTide: null,
            nextLowTide: null,
            currentLevel: null,
            // Explicit nulls, not absent keys -- which is what the live
            // upstream actually sends, and what a hand-built fixture got
            // wrong until a real request proved it.
            observedDeviation: null,
            ocean: null,
        };
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(noStation))),
        );
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/tide?lat=40.41&lng=-3.70' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ location: { code: null }, nextHighTide: null });
    });
});
