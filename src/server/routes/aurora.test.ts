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
