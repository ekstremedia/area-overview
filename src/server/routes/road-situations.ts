/**
 * `GET /api/road-situations?bbox=minLng,minLat,maxLng,maxLat` -- Statens
 * vegvesen's road notices (roadworks, closures, wind warnings, ferry
 * notices) for one viewport.
 *
 * The upstream is keyless, so in practice this route is always
 * `{configured: true, ...}` on success. The envelope keeps the
 * discriminated union anyway, to read the same way as `/api/ships` and
 * `/api/aircraft` -- see `shared/schemas/roads.ts`.
 *
 * Per-viewport rather than a nationwide snapshot (which `/api/ships`
 * uses): the GeoServer filters by bbox itself in 0.2s, so there is
 * nothing to gain by holding 3 MB of the whole country in memory to
 * serve a bbox out of it.
 *
 * Status (`current`/`scheduled`/`planned`) is computed here, once, from
 * this server's clock, and *all three* are sent: the client hides the
 * latter two unless `settings.roads.showPlanned`, so one cache entry
 * serves both preferences. The cost is that a status is at most one TTL
 * (two minutes) stale, which is why the boundaries in
 * `roads/situations.ts` are minutes-wide rather than seconds-wide.
 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../../shared/result.js';
import type { RoadSituationsResponse } from '../../shared/schemas/roads.js';
import { bboxCacheKey, clampBbox, parseBbox, roundBbox } from '../layers/bbox.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import type { OutboundGate } from '../outbound-gate.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { mapSituations } from '../roads/situations.js';
import { fetchFeatures, SITUATION_QUERY_EXTRA, SITUATION_RECORD_LIMIT, SITUATIONS_TYPE_NAME } from '../roads/vegvesen-wfs.js';

/** Matches `routes/ships.ts` and `routes/aircraft.ts` -- same reasoning, same number: on the public internet this key space is every 0.05-degree grid square on Earth, not one kiosk's viewport. */
const MAX_CACHED_VIEWPORTS = 64;

export interface RoadSituationsRouteDependencies {
    /** The process-wide Statens vegvesen budget, shared with `/api/road-cameras` (`app.ts`). A refusal is an ordinary upstream failure here: `serveCached` serves this viewport's stale answer, or 502 on a cold cache, and the web layer keeps the last good response either way. */
    gate?: OutboundGate | undefined;
}

export function registerRoadSituationsRoutes(app: FastifyInstance, config: ServerConfig, dependencies: RoadSituationsRouteDependencies = {}): void {
    // Only ever holds the `configured: true` variant -- typed as the full
    // union so it can be constructed and returned without a cast, exactly
    // as in `routes/ships.ts`.
    const cache = new TtlCache<RoadSituationsResponse>(config.roadSituationsCacheTtlMs, { maxEntries: MAX_CACHED_VIEWPORTS });

    app.get('/api/road-situations', async (request, reply) => {
        const query = request.query as { bbox?: unknown };
        const parsed = parseBbox(query.bbox);
        if (!parsed.ok) {
            reply.code(400).send({ error: parsed.error.message });
            return;
        }

        const bbox = roundBbox(clampBbox(parsed.value));

        await serveCached(
            request,
            reply,
            cache,
            bboxCacheKey(bbox),
            async () => {
                const result = await fetchFeatures(SITUATIONS_TYPE_NAME, bbox, {
                    upstreamTimeoutMs: config.upstreamTimeoutMs,
                    gate: dependencies.gate,
                    extra: SITUATION_QUERY_EXTRA,
                });
                if (!result.ok) return result;

                // The one failure of this design a visitor could never
                // see: a viewport dense enough to hit the cap is served
                // its freshest 500 records and told nothing. Logged so
                // that "a roadwork is missing from the map" has somewhere
                // to be looked up. The bbox is not logged -- see
                // `app.ts`'s request serializer.
                if (result.value.length >= SITUATION_RECORD_LIMIT) {
                    request.log.warn(
                        { records: result.value.length, limit: SITUATION_RECORD_LIMIT },
                        'road situations hit the per-viewport record cap; the oldest records in this viewport were truncated',
                    );
                }

                const now = new Date();
                return ok<RoadSituationsResponse>({
                    configured: true,
                    situations: mapSituations(result.value, now),
                    fetchedAt: now.toISOString(),
                });
            },
            {
                maxAgeSeconds: cacheSeconds(config.roadSituationsCacheTtlMs),
                // The cache key is the rounded bbox, and `serveCached`
                // logs the key on every failure -- which would write a
                // stream of viewports into the container log through the
                // error path, undoing on failure what `app.ts`'s request
                // serializer keeps on success. The route's name says
                // everything a log reader needs.
                logKey: 'road-situations',
            },
        );
    });
}
