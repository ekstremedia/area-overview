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
 * Netatmo readings -- Terje's own station, in his house -- are included
 * only when all three of these hold:
 *
 *   1. the request carries the settings password,
 *   2. `settings.weather.useNetatmo` is on,
 *   3. the request is for the home position.
 *
 * The third is not redundant. A forecast for Oslo carrying a temperature
 * measured in Sortland would be wrong as well as private, and the
 * upstream merges the station in regardless of the coordinates it is
 * given -- verified against the live API.
 *
 * The upstream document is cached ONCE, raw, and the strip applied per
 * response through `serveCached`'s `transform`. So an authorised and an
 * unauthorised request share one upstream call and get two correct
 * ETags, because `sendJson` hashes the body it is about to send.
 *
 * `/api/weather/summary` is deliberately NOT position-aware. It is an
 * LLM-written paragraph about Sortland, and there is nothing coordinates
 * could do to it but make it wrong about somewhere else.
 */
import type { FastifyInstance } from 'fastify';
import { WeatherSchema, WeatherSummaryResponseSchema, type Weather, type WeatherSummaryResponse } from '../../shared/schemas/weather.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { parsePointQuery, pointCacheKey, roundPoint, samePoint } from '../layers/point.js';
import { isAuthorizedRequest, PRODUCTION_AUTH_FAILURE_DELAY_MS } from '../settings/auth.js';
import type { SettingsStore } from '../settings/store.js';
import { stripNetatmo } from '../../shared/weather/strip-netatmo.js';
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

export interface WeatherRouteDependencies {
    /** The one settings store, for the Netatmo gate's own two conditions. */
    settings: SettingsStore;
    /** Test-only, mirroring `requireSettingsPassword`'s: the delay a wrong password costs here. */
    authFailureDelayMs?: number;
}

export function registerWeatherRoutes(app: FastifyInstance, config: ServerConfig, dependencies: WeatherRouteDependencies): void {
    const defaultCache = new TtlCache<Weather>(config.cacheTtlMs);
    // A separate cache from `defaultCache`, not another key in it: a point
    // forecast is held for ten minutes rather than thirty seconds, and the
    // kiosk's own view must not inherit that.
    const pointCache = new TtlCache<Weather>(config.pointForecastTtlMs, { maxEntries: MAX_CACHED_POINTS });
    const summaryCache = new TtlCache<WeatherSummaryResponse>(config.cacheTtlMs);

    /**
     * The three conditions, in the order that costs least. The position
     * check is free and settles most requests; the password comparison is
     * last because a wrong one deliberately sleeps.
     */
    async function includeNetatmo(authorization: string | undefined, position: { lat: number; lng: number } | null): Promise<boolean> {
        const settings = dependencies.settings.get();
        // Rounded on both sides: `homeView` is stored at four decimals and
        // a query arrives at two.
        const atHome = position === null || samePoint(position, roundPoint(settings.homeView));
        if (!atHome) return false;
        if (!settings.weather.useNetatmo) return false;
        return isAuthorizedRequest(config, authorization, dependencies.authFailureDelayMs ?? PRODUCTION_AUTH_FAILURE_DELAY_MS);
    }

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
            {
                // Never the cache key here: it carries the visitor's coordinates.
                maxAgeSeconds: cacheSeconds(ttlMs),
                logKey: position ? 'weather:point' : 'weather:home',
                privateCache: request.headers.authorization !== undefined,
                vary: 'Authorization',
                transform: async (document) => {
                    if (await includeNetatmo(request.headers.authorization, position)) return document;
                    // Fail closed: a `null` here becomes a 502 rather than
                    // serving the document with the station still in it.
                    return stripNetatmo(document);
                },
            },
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
