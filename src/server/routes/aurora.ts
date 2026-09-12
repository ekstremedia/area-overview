/**
 * `GET /api/aurora` -- proxies upstream `GET /api/aurora/all`, and adds
 * the aurora probability at the requested position.
 *
 * The position half cannot come from upstream: `/api/aurora/all` ignores
 * coordinates entirely, and its `oval.grid.maxProbabilityZones` array
 * comes back empty. So this route is the one place the BFF consults a
 * source of its own -- NOAA's OVATION model, via `aurora/ovation.ts`.
 *
 * The upstream document is cached once under its usual key and the point
 * is attached per response through `serveCached`'s `transform`, so two
 * visitors at different positions cost one upstream call and get two
 * correct ETags.
 */
import type { FastifyInstance } from 'fastify';
import { AuroraAllSchema, type AuroraAll } from '../../shared/schemas/aurora.js';
import { createOvationClient, OVATION_ATTRIBUTION, OVATION_ATTRIBUTION_URL, type OvationClient } from '../aurora/ovation.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { parsePointQuery } from '../layers/point.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { fetchUpstream } from '../upstream.js';

export interface AuroraRouteDependencies {
    /** Injectable so tests can drive the grid without reaching NOAA; the real one is built here when omitted. */
    ovation?: OvationClient;
}

export function registerAuroraRoutes(app: FastifyInstance, config: ServerConfig, dependencies: AuroraRouteDependencies = {}): void {
    const cache = new TtlCache<AuroraAll>(config.cacheTtlMs);
    const ovation = dependencies.ovation ?? createOvationClient({ upstreamTimeoutMs: config.upstreamTimeoutMs });

    app.get('/api/aurora', async (request, reply) => {
        const point = parsePointQuery(request.query);
        if (!point.ok) {
            reply.code(400).send({ error: point.error.message });
            return;
        }

        const position = point.value;

        await serveCached(request, reply, cache, 'aurora:all', () => fetchUpstream('/api/aurora/all', AuroraAllSchema, config), {
            maxAgeSeconds: cacheSeconds(config.cacheTtlMs),
            logKey: 'aurora:all',
            transform: async (document) => {
                if (!position) return document;
                const grid = await ovation.gridFor();
                // NOAA has never answered, or is down. The rest of the
                // document is untouched and complete: this figure is an
                // enrichment, and its absence must not cost the page.
                if (!grid) return document;
                return {
                    ...document,
                    point: {
                        lat: position.lat,
                        lng: position.lng,
                        probability: grid.probabilityAt(position.lat, position.lng),
                        observationTime: grid.observationTime,
                        forecastTime: grid.forecastTime,
                        attribution: OVATION_ATTRIBUTION,
                        attributionUrl: OVATION_ATTRIBUTION_URL,
                    },
                };
            },
        });
    });
}
