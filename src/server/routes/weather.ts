/**
 * `GET /api/weather` -- proxies upstream `GET /api/weather` and
 * `GET /api/weather/summary`, the former optionally for a given position.
 *
 * `?lat&lng` is forwarded to the upstream, which answers with a point
 * forecast for those coordinates. Without them it answers for its own
 * configured location, which is what the kiosk and every ordinary visitor
 * get -- and what keeps them all on one cache key.
 *
 * The parameter is `lng`, never `lon`: the upstream silently ignores
 * `lon` and answers for Sortland instead of erroring, so the spelling is
 * pinned by a test.
 *
 * `/api/weather/summary` is deliberately NOT position-aware. It is an
 * LLM-written paragraph about Sortland, and there is nothing coordinates
 * could do to it but make it wrong about somewhere else.
 */
import type { FastifyInstance } from 'fastify';
import { WeatherSchema, WeatherSummaryResponseSchema, type Weather, type WeatherSummaryResponse } from '../../shared/schemas/weather.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { parsePointQuery, pointCacheKey } from '../layers/point.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { fetchUpstream } from '../upstream.js';

/**
 * Distinct positions the point cache remembers. A weather document is
 * ~137KB parsed, so 32 is roughly 10MB worst case -- far more than the
 * handful of viewpoints any real set of simultaneous visitors produces,
 * and bounded because the key space behind a public endpoint is every
 * rounded coordinate on Earth.
 */
const MAX_CACHED_POINTS = 32;

export function registerWeatherRoutes(app: FastifyInstance, config: ServerConfig): void {
    const defaultCache = new TtlCache<Weather>(config.cacheTtlMs);
    // A separate cache from `defaultCache`, not another key in it: a point
    // forecast is held for ten minutes rather than thirty seconds, and the
    // kiosk's own view must not inherit that.
    const pointCache = new TtlCache<Weather>(config.pointForecastTtlMs, { maxEntries: MAX_CACHED_POINTS });
    const summaryCache = new TtlCache<WeatherSummaryResponse>(config.cacheTtlMs);

    app.get('/api/weather', async (request, reply) => {
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
            position ? pointCache : defaultCache,
            `weather:${pointCacheKey(position)}`,
            () => fetchUpstream('/api/weather', WeatherSchema, config, position ? { query: { lat: position.lat, lng: position.lng } } : {}),
            // Never the cache key here: it carries the visitor's coordinates.
            { maxAgeSeconds: cacheSeconds(ttlMs), logKey: position ? 'weather:point' : 'weather:home' },
        );
    });

    app.get('/api/weather/summary', async (request, reply) => {
        await serveCached(
            request,
            reply,
            summaryCache,
            'weather:summary',
            () =>
                // Upstream answers 204 (no body) before it has generated a first
                // summary; that's a defined empty state, not an error -- see
                // `EmptyWeatherSummarySchema`.
                fetchUpstream('/api/weather/summary', WeatherSummaryResponseSchema, config, { on204: { summary: null } }),
            { maxAgeSeconds: cacheSeconds(config.cacheTtlMs) },
        );
    });
}
