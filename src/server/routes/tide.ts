/**
 * `GET /api/tide` -- proxies upstream `GET /api/tide` with a fixed
 * `timespan=24h`. This phase does not forward any client query
 * parameters upstream.
 */
import type { FastifyInstance } from 'fastify';
import { TideSchema, type Tide } from '../../shared/schemas/tide.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { serveCached } from '../route-helpers.js';
import { fetchUpstream } from '../upstream.js';

export function registerTideRoutes(app: FastifyInstance, config: ServerConfig): void {
    const cache = new TtlCache<Tide>(config.cacheTtlMs);

    app.get('/api/tide', async (request, reply) => {
        await serveCached(request, reply, cache, 'tide:24h', () => fetchUpstream('/api/tide?timespan=24h', TideSchema, config));
    });
}
