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
 * Status (`current`/`scheduled`/`planned`) is derived from the clock, so
 * it is derived on the way OUT, never cached. What the cache holds is
 * upstream's raw records; `serveCached`'s `transform` runs
 * `mapSituations(features, new Date())` on every single response, fresh
 * or stale.
 *
 * That is not tidiness, it is correctness. `TtlCache` has no maximum
 * stale age -- an entry leaves only by LRU eviction or by a successful
 * replacement -- and `serveCached` deliberately serves a stale entry when
 * a refresh fails. Caching the mapped response would therefore mean that
 * during a GeoServer outage a roadwork which ended hours ago kept being
 * served as `current`, and one that was `planned` never became `current`:
 * a timestamp-shaped lie, told with full confidence, for as long as the
 * outage lasted. Mapping at serve time costs a few milliseconds per
 * request and buys a response that is always honest about *now*.
 *
 * Two things it cannot fix, and does not pretend to: `fetchedAt` remains
 * the time upstream was actually asked (the client shows it as an age,
 * and inventing a fresher one would be the same lie in another place),
 * and `ACTIVE` -- upstream's own "inside a validity period right now"
 * flag -- is as old as the cached record it came from, so the
 * `scheduled`/`current` split for a periodic situation is at most one
 * TTL stale in normal operation. Expiry and the planned-to-current
 * transition, which are computed from timestamps this server holds, are
 * always exact.
 *
 * All three statuses are sent: the client hides `scheduled`/`planned`
 * unless `settings.roads.showPlanned`, so one cache entry serves both
 * preferences.
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
import { fetchFeatures, SITUATION_QUERY_EXTRA, SITUATION_RECORD_LIMIT, SITUATIONS_TYPE_NAME, type RawFeature } from '../roads/vegvesen-wfs.js';

/** Matches `routes/ships.ts` and `routes/aircraft.ts` -- same reasoning, same number: on the public internet this key space is every 0.05-degree grid square on Earth, not one kiosk's viewport. */
const MAX_CACHED_VIEWPORTS = 64;

/**
 * What one cache entry holds: the records exactly as upstream sent them,
 * and when they were fetched. Nothing derived from the clock is stored --
 * that is the whole point (see this file's header).
 */
interface CachedSituationRecords {
    features: RawFeature[];
    /** When upstream was asked. Travels to the client as `fetchedAt`, unchanged, so a stale response reports its real age. */
    fetchedAt: string;
}

export interface RoadSituationsRouteDependencies {
    /** The process-wide Statens vegvesen budget, shared with `/api/road-cameras` (`app.ts`). A refusal is an ordinary upstream failure here: `serveCached` serves this viewport's stale answer, or 502 on a cold cache, and the web layer keeps the last good response either way. */
    gate?: OutboundGate | undefined;
}

export function registerRoadSituationsRoutes(app: FastifyInstance, config: ServerConfig, dependencies: RoadSituationsRouteDependencies = {}): void {
    const cache = new TtlCache<CachedSituationRecords>(config.roadSituationsCacheTtlMs, { maxEntries: MAX_CACHED_VIEWPORTS });

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

                // Cached as fetched. The mapping -- and with it every
                // judgement about "now" -- happens in the transform
                // below, on the way out.
                return ok<CachedSituationRecords>({ features: result.value, fetchedAt: new Date().toISOString() });
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
                // Every response, fresh or stale, re-reads the clock. An
                // ended situation is dropped here even if the cached
                // records are hours old and upstream has been down the
                // whole time; `fetchedAt` still reports when they were
                // actually fetched.
                transform: (document): RoadSituationsResponse => ({
                    configured: true,
                    situations: mapSituations(document.features, new Date()),
                    fetchedAt: document.fetchedAt,
                }),
            },
        );
    });
}
