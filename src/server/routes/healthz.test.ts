import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../../shared/version.js';
import { buildTestApp } from './test-helpers.js';

describe('GET /healthz', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reports upstream reachable and the app version', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/healthz' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, upstream: 'reachable', version: APP_VERSION });
    });

    it('reports upstream unreachable without failing the request', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/healthz' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, upstream: 'unreachable', version: APP_VERSION });
    });
});
