/**
 * `GET /api/cameras` -- proxies upstream `GET /api/app/cameras`.
 *
 * The validated upstream envelope (`{ cameras, cached_at }`) is passed
 * through as-is rather than re-wrapped or stripped: the frontend needs
 * both the list and the upstream's own `cached_at`, and this server's own
 * `ETag`/`X-Cache` headers already communicate this server's caching
 * state, so there is no second wrapper to add.
 */
import type { FastifyInstance } from 'fastify';
import { CameraListResponseSchema, type CameraListResponse } from '../../shared/schemas/camera.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { serveCached } from '../route-helpers.js';
import { fetchUpstream } from '../upstream.js';

export function registerCameraRoutes(app: FastifyInstance, config: ServerConfig): void {
    const cache = new TtlCache<CameraListResponse>(config.cacheTtlMs);

    app.get('/api/cameras', async (request, reply) => {
        await serveCached(request, reply, cache, 'cameras:all', () => fetchUpstream('/api/app/cameras', CameraListResponseSchema, config));
    });
}
