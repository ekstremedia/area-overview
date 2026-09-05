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
