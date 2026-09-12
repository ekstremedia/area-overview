/**
 * `GET /api/tide` -- proxies upstream `GET /api/tide` with a fixed
 * `timespan=24h`, optionally for a given position.
 *
 * `?lat&lng` is forwarded to the upstream, which picks the nearest
 * Kartverket station itself (verified against the live API: Oslo
 * coordinates come back as station `OSL`). Without them the upstream
 * answers for its own configured station, which is what the kiosk and
 * every ordinary visitor get -- and what keeps them all on one cache key.
 *
 * Note that the parameter is `lng`, never `lon`: the upstream silently
 * ignores `lon` and answers for Sortland instead of erroring, so the
 * spelling is pinned by a test.
 */
import type { FastifyInstance } from 'fastify';
import { TideSchema, type Tide } from '../../shared/schemas/tide.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { parsePointQuery, pointCacheKey } from '../layers/point.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { fetchUpstream } from '../upstream.js';

/**
 * Distinct positions the point cache remembers. Smaller entries than the
 * weather cache (~37KB against ~137KB), so it can afford more of them;
 * both are capped because the key space behind a public endpoint is every
 * rounded coordinate on Earth.
 */
const MAX_CACHED_POINTS = 64;

export function registerTideRoutes(app: FastifyInstance, config: ServerConfig): void {
    const cache = new TtlCache<Tide>(config.cacheTtlMs);
    // A separate cache, not a second key in the one above: point requests
    // hold a much longer TTL, and the home position must not inherit it.
    const pointCache = new TtlCache<Tide>(config.pointForecastTtlMs, { maxEntries: MAX_CACHED_POINTS });

    app.get('/api/tide', async (request, reply) => {
        const point = parsePointQuery(request.query);
        if (!point.ok) {
            reply.code(400).send({ error: point.error.message });
            return;
        }

        const position = point.value;
        const ttlMs = position ? config.pointForecastTtlMs : config.cacheTtlMs;

        await serveCached(
            request,
            reply,
            position ? pointCache : cache,
            `tide:24h:${pointCacheKey(position)}`,
            () => fetchUpstream('/api/tide?timespan=24h', TideSchema, config, position ? { query: { lat: position.lat, lng: position.lng } } : {}),
            // Never the cache key here: it carries the visitor's coordinates.
            { maxAgeSeconds: cacheSeconds(ttlMs), logKey: position ? 'tide:point' : 'tide:home' },
        );
    });
}
