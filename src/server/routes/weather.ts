/**
 * `GET /api/weather` -- proxies upstream `GET /api/weather` (optionally
 * with `lat`/`lng` for a point forecast) and `GET /api/weather/summary`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WeatherSchema, WeatherSummaryResponseSchema, type Weather, type WeatherSummaryResponse } from '../../shared/schemas/weather.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { serveCached } from '../route-helpers.js';
import { fetchUpstream } from '../upstream.js';

/**
 * Coordinates are rounded to two decimal places (~1.1km at this latitude)
 * before being used in either the cache key or the upstream request.
 * Upstream caches per-exact-float for 10 minutes, so unrounded coordinates
 * would defeat this server's own cache entirely.
 */
function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

const WeatherQuerySchema = z.object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
});

export function registerWeatherRoutes(app: FastifyInstance, config: ServerConfig): void {
    const defaultCache = new TtlCache<Weather>(config.cacheTtlMs);
    const pointCache = new TtlCache<Weather>(config.pointForecastTtlMs);
    const summaryCache = new TtlCache<WeatherSummaryResponse>(config.cacheTtlMs);

    app.get('/api/weather', async (request, reply) => {
        const query = WeatherQuerySchema.safeParse(request.query);
        if (!query.success) {
            reply.code(400).send({ error: 'Invalid lat/lng query parameter' });
            return;
        }

        const { lat, lng } = query.data;
        if ((lat === undefined) !== (lng === undefined)) {
            reply.code(400).send({ error: 'lat and lng must be provided together' });
            return;
        }

        if (lat === undefined || lng === undefined) {
            await serveCached(request, reply, defaultCache, 'weather:default', () => fetchUpstream('/api/weather', WeatherSchema, config));
            return;
        }

        const roundedLat = round2(lat);
        const roundedLng = round2(lng);
        const key = `weather:point:${String(roundedLat)}:${String(roundedLng)}`;
        await serveCached(request, reply, pointCache, key, () =>
            fetchUpstream(`/api/weather?lat=${String(roundedLat)}&lng=${String(roundedLng)}`, WeatherSchema, config),
        );
    });

    app.get('/api/weather/summary', async (request, reply) => {
        await serveCached(request, reply, summaryCache, 'weather:summary', () =>
            fetchUpstream('/api/weather/summary', WeatherSummaryResponseSchema, config),
        );
    });
}
