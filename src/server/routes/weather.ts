/**
 * `GET /api/weather` -- proxies upstream `GET /api/weather` and
 * `GET /api/weather/summary`.
 */
import type { FastifyInstance } from 'fastify';
import { WeatherSchema, WeatherSummaryResponseSchema, type Weather, type WeatherSummaryResponse } from '../../shared/schemas/weather.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { fetchUpstream } from '../upstream.js';

export function registerWeatherRoutes(app: FastifyInstance, config: ServerConfig): void {
    const defaultCache = new TtlCache<Weather>(config.cacheTtlMs);
    const summaryCache = new TtlCache<WeatherSummaryResponse>(config.cacheTtlMs);

    app.get('/api/weather', async (request, reply) => {
        await serveCached(request, reply, defaultCache, 'weather:default', () => fetchUpstream('/api/weather', WeatherSchema, config), {
            maxAgeSeconds: cacheSeconds(config.cacheTtlMs),
        });
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
