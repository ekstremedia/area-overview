/**
 * `Cache-Control` across every route, asserted in one place rather than
 * scattered through each route's own file: the interesting property is
 * that the whole surface agrees -- cached proxy routes advertise their own
 * TTL, the one write surface advertises nothing, and a body this server
 * has already given up on is never handed out with a freshness lifetime.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import weatherFixture from '../../shared/fixtures/weather.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Cache-Control', () => {
    it("advertises a cached proxy route's own TTL, with a short revalidation window", async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const app = buildTestApp({ cacheTtlMs: 30_000 });

        const response = await app.inject({ method: 'GET', url: '/api/weather' });

        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=60');
    });

    it('never advertises a longer lifetime than this server itself considers fresh', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        // 1500ms of TTL must round down to 1s, not up to 2s: a browser
        // holding a response past the point the BFF has replaced it is
        // exactly what this header must not cause.
        const app = buildTestApp({ cacheTtlMs: 1_500 });

        const response = await app.inject({ method: 'GET', url: '/api/weather' });

        expect(response.headers['cache-control']).toBe('public, max-age=1, stale-while-revalidate=60');
    });

    it('still sends a usable max-age for a sub-second TTL rather than max-age=0', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const app = buildTestApp({ cacheTtlMs: 200 });

        const response = await app.inject({ method: 'GET', url: '/api/weather' });

        expect(response.headers['cache-control']).toBe('public, max-age=1, stale-while-revalidate=60');
    });

    it('sends no freshness lifetime on a stale body, which this server has already given up on', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ cacheTtlMs: 10 });

        const warm = await app.inject({ method: 'GET', url: '/api/weather' });
        expect(warm.statusCode).toBe(200);

        await sleep(20);
        fetchMock.mockRejectedValue(new Error('network down'));

        const stale = await app.inject({ method: 'GET', url: '/api/weather' });

        expect(stale.headers['x-cache']).toBe('stale');
        // `no-cache`, not an absent header: a browser must ask before
        // showing this again.
        expect(stale.headers['cache-control']).toBe('no-cache');
    });

    it('overrides a stored max-age on the 304 path, rather than granting a stale body a fresh lifetime', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(weatherFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ cacheTtlMs: 10 });

        // A client that already holds this exact body, from back when the
        // route was fresh and sent `max-age`.
        const fresh = await app.inject({ method: 'GET', url: '/api/weather' });
        const etag = String(fresh.headers.etag);
        expect(fresh.headers['cache-control']).toContain('max-age=');

        await sleep(20);
        fetchMock.mockRejectedValue(new Error('network down'));

        const revalidated = await app.inject({ method: 'GET', url: '/api/weather', headers: { 'if-none-match': etag } });

        // RFC 9111: a 304 updates the stored response's headers. Without a
        // `Cache-Control` here, the stored `max-age` from the fresh
        // response would survive -- so a revalidation that *learns the
        // data is stale* would hand the client another full freshness
        // lifetime of it.
        expect(revalidated.statusCode).toBe(304);
        expect(revalidated.headers['cache-control']).toBe('no-cache');
    });

    it('tells clients never to store settings, the one thing that changes from another device', async () => {
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/settings' });

        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        // And still no ETag: a 304 here would be the same lie in another form.
        expect(response.headers.etag).toBeUndefined();
    });

    it('keeps the ETag/304 path working alongside the new header', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(weatherFixture)));
        const app = buildTestApp({ cacheTtlMs: 30_000 });

        const first = await app.inject({ method: 'GET', url: '/api/weather' });
        const etag = first.headers.etag;
        expect(typeof etag).toBe('string');

        const second = await app.inject({ method: 'GET', url: '/api/weather', headers: { 'if-none-match': String(etag) } });

        expect(second.statusCode).toBe(304);
    });
});
