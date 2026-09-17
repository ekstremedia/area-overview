/**
 * `GET /api/transit?bbox=minLng,minLat,maxLng,maxLat&maxAgeMinutes=N` --
 * Entur's realtime buses and ferries for one viewport.
 *
 * The upstream is keyless, so in practice this route is always
 * `{configured: true, ...}` on success -- the envelope keeps the
 * discriminated union anyway, to read the same way as every other live
 * layer (see `shared/schemas/transit.ts`).
 *
 * Unlike `roads/situations.ts`, where the thing that changes on the way
 * OUT is a status derived from the clock, here it is which vehicles are
 * shown at all: a vehicle's `lastUpdated` is a position fix that goes
 * stale, and Entur keeps it in the feed for hours past that (until its
 * own `expiration`). So the cache holds upstream's raw records, exactly
 * like `road-situations.ts`, and `mapVehicles(records, new Date(),
 * maxAgeMinutes, ...)` runs on every single response, fresh or stale --
 * never on the way into the cache. That is what keeps a parked bus from
 * being served as live traffic for the rest of an outage, and what lets
 * `maxAgeMinutes` (this request's own, from the query string, defaulting
 * to `settings.transit.maxAgeMinutes`'s own default of 10) vary per
 * request while the upstream fetch itself stays keyed on the bbox alone
 * -- one POST per cache miss, however many different max-ages are asked
 * for against it.
 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../../shared/result.js';
import { TRANSIT_LAYER } from '../../shared/layers.js';
import type { TransitResponse } from '../../shared/schemas/transit.js';
import { bboxCacheKey, clampBbox, parseBbox, roundBbox } from '../layers/bbox.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import type { OutboundGate } from '../outbound-gate.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { DiscardTally } from '../transit/discards.js';
import { fetchVehicles, type RawVehicleRecord } from '../transit/entur.js';
import { mapVehicles } from '../transit/vehicles.js';

/** Matches `routes/road-situations.ts` -- same reasoning, same number: on the public internet this key space is every 0.05-degree grid square on Earth, not one kiosk's viewport. */
const MAX_CACHED_VIEWPORTS = 64;

/** `settings.transit.maxAgeMinutes`'s own default (`shared/schemas/settings.ts`) -- used when the query string carries none. */
const DEFAULT_MAX_AGE_MINUTES = 10;

/**
 * What one cache entry holds: the records exactly as Entur sent them,
 * and when they were fetched. Nothing derived from the clock or from a
 * particular request's `maxAgeMinutes` is stored -- that is the whole
 * point (see this file's header).
 */
interface CachedVehicleRecords {
    records: RawVehicleRecord[];
    /** When upstream was asked. Travels to the client as `fetchedAt`, unchanged, so a stale response reports its real age. */
    fetchedAt: string;
}

export interface TransitRouteDependencies {
    /** The process-wide Entur outbound budget (`app.ts`). A refusal is an ordinary upstream failure here: `serveCached` serves this viewport's stale answer, or 502 on a cold cache, the same path an upstream outage already takes. */
    gate?: OutboundGate | undefined;
}

/** Parses `?maxAgeMinutes=`, clamped to the layer's own bounds and falling back to its default for anything missing or unparseable -- never a 400, since an out-of-range or malformed value here costs only how aggressively vehicles are filtered, not the request. */
function parseMaxAgeMinutes(raw: unknown): number {
    const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value)) return DEFAULT_MAX_AGE_MINUTES;

    const min = TRANSIT_LAYER.maxAgeMinutesMin ?? DEFAULT_MAX_AGE_MINUTES;
    const max = TRANSIT_LAYER.maxAgeMinutesMax ?? DEFAULT_MAX_AGE_MINUTES;
    return Math.min(max, Math.max(min, value));
}

export function registerTransitRoutes(app: FastifyInstance, config: ServerConfig, dependencies: TransitRouteDependencies = {}): void {
    const cache = new TtlCache<CachedVehicleRecords>(config.transitCacheTtlMs, { maxEntries: MAX_CACHED_VIEWPORTS });

    app.get('/api/transit', async (request, reply) => {
        const query = request.query as { bbox?: unknown; maxAgeMinutes?: unknown };
        const parsed = parseBbox(query.bbox);
        if (!parsed.ok) {
            reply.code(400).send({ error: parsed.error.message });
            return;
        }

        const bbox = roundBbox(clampBbox(parsed.value));
        const maxAgeMinutes = parseMaxAgeMinutes(query.maxAgeMinutes);

        await serveCached(
            request,
            reply,
            cache,
            bboxCacheKey(bbox),
            async () => {
                const result = await fetchVehicles(bbox, {
                    upstreamTimeoutMs: config.upstreamTimeoutMs,
                    clientName: config.enturClientName,
                    gate: dependencies.gate,
                });
                if (!result.ok) return result;

                // Cached as fetched. The mapping -- mode filter, age
                // filter and with it every judgement about "now" --
                // happens in the transform below, on the way out.
                return ok<CachedVehicleRecords>({ records: result.value, fetchedAt: new Date().toISOString() });
            },
            {
                maxAgeSeconds: cacheSeconds(config.transitCacheTtlMs),
                // The cache key is the rounded bbox, and `serveCached` logs
                // the key on every failure -- which would write a stream of
                // viewports into the container log through the error path.
                // The route's name says everything a log reader needs.
                logKey: 'transit',
                transform: (document): TransitResponse => {
                    const discards = new DiscardTally();
                    const vehicles = mapVehicles(document.records, new Date(), maxAgeMinutes, discards);

                    // The invisible failure this guards against: a renamed
                    // upstream field empties this layer while the map
                    // reads "no buses right now" -- exactly what a quiet
                    // night looks like too. One warn per response, counts
                    // only, no bbox: the same rule `road-situations.ts`
                    // follows for its own discard warning.
                    if (discards.dropped > 0) {
                        request.log.warn(
                            discards.summary(),
                            'transit vehicle records were discarded while mapping; the layer is showing less than upstream sent',
                        );
                    }

                    return { configured: true, vehicles, fetchedAt: document.fetchedAt };
                },
            },
        );
    });
}
