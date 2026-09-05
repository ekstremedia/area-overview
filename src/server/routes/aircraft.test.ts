import { afterEach, describe, expect, it, vi } from 'vitest';
import { AircraftResponseSchema } from '../../shared/schemas/aircraft.js';
import adsbLolFixture from '../aircraft/fixtures/adsb-lol-live.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

// Deliberately within the route's own 2°x2° `clampBbox` limit (unlike
// `provider.test.ts`'s unclamped 4°-wide bbox) -- the real fixture's two
// aircraft are ~2.23° of longitude apart, wider than any single bbox this
// route ever queries with, so a route-level test asserts "at least one
// aircraft comes through the whole HTTP path", not an exact count; the
// exact-count assertion (both aircraft parse from the raw fixture) lives
// in `provider.test.ts`, one layer down, where clamping doesn't apply.
const VALID_BBOX = 'bbox=15.5,67.9,17.5,69.9';

describe('GET /api/aircraft', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is configured by default, with zero credentials, against the real captured adsb.lol fixture', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(adsbLolFixture)));
        const app = buildTestApp({ adsbProvider: 'adsblol' });

        const response = await app.inject({ method: 'GET', url: `/api/aircraft?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = AircraftResponseSchema.parse(response.json());
        expect(body.configured).toBe(true);
        if (body.configured) {
            expect(body.aircraft.length).toBeGreaterThanOrEqual(1);
            expect(typeof body.fetchedAt).toBe('string');
        }
    });

    it('responds 400 for an unparseable bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp({ adsbProvider: 'adsblol' });

        const response = await app.inject({ method: 'GET', url: '/api/aircraft?bbox=nope' });

        expect(response.statusCode).toBe(400);
    });

    it('responds 400 for a missing bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp({ adsbProvider: 'adsblol' });

        const response = await app.inject({ method: 'GET', url: '/api/aircraft' });

        expect(response.statusCode).toBe(400);
    });

    it('clamps an oversized bbox rather than rejecting it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(adsbLolFixture)));
        const app = buildTestApp({ adsbProvider: 'adsblol' });

        const response = await app.inject({ method: 'GET', url: '/api/aircraft?bbox=-170,-80,170,80' });

        expect(response.statusCode).toBe(200);
    });

    it('serves stale aircraft on an upstream hiccup after a warm cache', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(adsbLolFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ adsbProvider: 'adsblol', aircraftCacheTtlMs: 10 });

        const warm = await app.inject({ method: 'GET', url: `/api/aircraft?${VALID_BBOX}` });
        expect(warm.statusCode).toBe(200);

        await sleep(20);
        fetchMock.mockRejectedValue(new Error('network down'));

        const stale = await app.inject({ method: 'GET', url: `/api/aircraft?${VALID_BBOX}` });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
    });

    it('responds 502 on a cold cache when the ADS-B provider is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const app = buildTestApp({ adsbProvider: 'adsblol' });

        const response = await app.inject({ method: 'GET', url: `/api/aircraft?${VALID_BBOX}` });

        expect(response.statusCode).toBe(502);
    });
});
