/**
 * `GET /api/aurora` -- proxies upstream `GET /api/aurora/all`.
 */
import type { FastifyInstance } from 'fastify';
import { AuroraAllSchema, type AuroraAll } from '../../shared/schemas/aurora.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { fetchUpstream } from '../upstream.js';

export function registerAuroraRoutes(app: FastifyInstance, config: ServerConfig): void {
    const cache = new TtlCache<AuroraAll>(config.cacheTtlMs);

    app.get('/api/aurora', async (request, reply) => {
        await serveCached(request, reply, cache, 'aurora:all', () => fetchUpstream('/api/aurora/all', AuroraAllSchema, config), {
            maxAgeSeconds: cacheSeconds(config.cacheTtlMs),
        });
    });
}
