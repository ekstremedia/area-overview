import { afterEach, describe, expect, it, vi } from 'vitest';
import auroraFixture from '../../shared/fixtures/aurora.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

describe('GET /api/aurora', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the validated aurora data on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(auroraFixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/aurora' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(auroraFixture);
        expect(response.headers.etag).toBeDefined();
    });

    it('responds 502 on a cold cache when upstream is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/aurora' });

        expect(response.statusCode).toBe(502);
    });

    it('serves the stale cached value with X-Cache: stale when upstream later fails', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(auroraFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ cacheTtlMs: 10 });

        const warm = await app.inject({ method: 'GET', url: '/api/aurora' });
        expect(warm.statusCode).toBe(200);

        await sleep(20);
        fetchMock.mockRejectedValue(new Error('network down'));

        const stale = await app.inject({ method: 'GET', url: '/api/aurora' });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
    });

    it('single-flights concurrent requests into one upstream call', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(auroraFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        const [first, second] = await Promise.all([
            app.inject({ method: 'GET', url: '/api/aurora' }),
            app.inject({ method: 'GET', url: '/api/aurora' }),
        ]);

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('GET /api/aurora -- by position', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** A grid standing in for NOAA, so the route can be driven without a 918KB download. */
    function fakeOvation(probability: number) {
        return {
            gridFor: vi.fn(() =>
                Promise.resolve({
                    observationTime: '2026-09-12T19:29:00Z',
                    forecastTime: '2026-09-12T20:36:00Z',
                    probabilityAt: () => probability,
                }),
            ),
        };
    }

    it('attaches the probability at the requested position', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(auroraFixture)));
        const app = buildTestApp({}, { ovation: fakeOvation(9) });

        const response = await app.inject({ method: 'GET', url: '/api/aurora?lat=68.6984&lng=15.4129' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            point: { lat: 68.7, lng: 15.41, probability: 9, attribution: 'NOAA SWPC (OVATION)' },
        });
    });

    it('adds no point at all for the home position', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(auroraFixture)));
        const app = buildTestApp({}, { ovation: fakeOvation(9) });

        const response = await app.inject({ method: 'GET', url: '/api/aurora' });

        expect(response.json()).not.toHaveProperty('point');
    });

    it('still answers with the rest of the document when NOAA has never replied', async () => {
        // The figure is an enrichment on a response that was already
        // complete without it; a NOAA outage must not cost the page.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(auroraFixture)));
        const app = buildTestApp({}, { ovation: { gridFor: vi.fn(() => Promise.resolve(null)) } });

        const response = await app.inject({ method: 'GET', url: '/api/aurora?lat=68.7&lng=15.41' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).not.toHaveProperty('point');
        expect(response.json()).toHaveProperty('status');
    });

    it('serves two positions from one upstream call, with different ETags', async () => {
        // The whole point of the transform hook: one canonical cached
        // document, two correct responses.
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(auroraFixture)));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({}, { ovation: fakeOvation(9) });

        const first = await app.inject({ method: 'GET', url: '/api/aurora?lat=68.70&lng=15.41' });
        const second = await app.inject({ method: 'GET', url: '/api/aurora?lat=59.91&lng=10.75' });

        const upstreamCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/aurora/all'));
        expect(upstreamCalls).toHaveLength(1);
        expect(first.headers.etag).not.toBe(second.headers.etag);
    });

    it('rejects half a position', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(auroraFixture)));
        const app = buildTestApp({}, { ovation: fakeOvation(9) });

        expect((await app.inject({ method: 'GET', url: '/api/aurora?lat=68.7' })).statusCode).toBe(400);
    });

    it('never sends the grid itself to a browser', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(auroraFixture)));
        const app = buildTestApp({}, { ovation: fakeOvation(9) });

        const response = await app.inject({ method: 'GET', url: '/api/aurora?lat=68.7&lng=15.41' });

        // A scalar, not 65160 triples: the response must stay in the same
        // order of magnitude it has always been.
        expect(response.body.length).toBeLessThan(200_000);
        expect(response.json()).not.toHaveProperty('coordinates');
    });
});
