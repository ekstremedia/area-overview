/**
 * `GET /api/warnings?bbox=minLng,minLat,maxLng,maxLat` -- MET Alerts
 * weather warnings and NVE Varsom avalanche warnings for one viewport,
 * merged into the one envelope `WarningsResponseSchema` describes.
 *
 * Unlike every other live-layer route, this one does NOT use
 * `route-helpers.ts`'s `serveCached`: that helper is built around one
 * cache and one upstream fetch per response, and this route's whole point
 * is that MET Alerts and NVE Varsom must be able to fail independently
 * (`WarningsResponseSchema`'s own header: "a failure of either half must
 * still serve the other"). Sharing one cache/fetch between them would tie
 * their fates together purely as an accident of implementation. Instead:
 *
 *  - The MET half caches the raw nationwide feature list under one fixed
 *    key -- mirroring `regions.ts`'s own 24h roster cache -- rather than
 *    per bbox, since `fetchMetAlerts` always fetches the whole country
 *    regardless of viewport (see `met-alerts.ts`'s header). The bbox
 *    intersection (`mapMetAlerts`) then runs fresh per request against
 *    that cached list, the same way the avalanche half already maps a
 *    cached roster per request. Loaded through `warnings/stale-cache.ts`'s
 *    `loadWithStaleFallback` -- the same "serve what's cached, however
 *    stale, rather than nothing" policy `serveCached` gives every other
 *    route, just invoked directly instead of through a `FastifyReply`.
 *  - The avalanche half has no per-bbox cache of its own at all: its two
 *    real costs -- the region roster and each region's daily warning --
 *    are already independently cached at their own natural granularity
 *    (`regions.ts`'s 24h roster cache, and this route's own 1800s
 *    per-region-id cache below). Intersecting a bbox against an
 *    already-cached roster and building each entry's `point` is cheap CPU,
 *    done fresh on every request -- there is nothing left to cache per
 *    bbox that isn't already cached per region.
 *  - Both outcomes are combined into one envelope only at the very end,
 *    where `sendJson` (`route-helpers.ts`, exported for this route alone)
 *    writes the single HTTP response with one merged `X-Cache`/staleness
 *    flag -- `true` if either half had to fall back to a stale value.
 *
 * The route only ever responds `502` when BOTH halves come back with
 * nothing to serve at all (no fresh fetch, no stale fallback for either) --
 * exactly mirroring `serveCached`'s own cold-cache 502, just evaluated
 * across two upstreams instead of one.
 */
import type { FastifyInstance } from 'fastify';
import type { Result } from '../../shared/result.js';
import type { AvalancheWarning, WarningsResponse, WeatherWarning } from '../../shared/schemas/warnings.js';
import { fetchRegionWarning, mapAvalancheWarning, type RawWarningEntry } from '../warnings/avalanche.js';
import { fetchMetAlerts, mapMetAlerts, type RawMetFeature } from '../warnings/met-alerts.js';
import { createRegionsSource, regionsIntersecting } from '../warnings/regions.js';
import { loadWithStaleFallback } from '../warnings/stale-cache.js';
import { clampBbox, parseBbox, roundBbox } from '../layers/bbox.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import type { OutboundGate } from '../outbound-gate.js';
import { cacheSeconds, sendJson } from '../route-helpers.js';

/** One entry per `regionId:dateStr` actually asked for; NVE has 46 regions total, and a UTC date rollover briefly doubles that to two dates' worth of entries at most, so this can never grow far past ~2x46 regardless of how many distinct viewports are served. */
const MAX_CACHED_REGION_WARNINGS = 64;

/** A fixed key: one nationwide MET Alerts feature list, not one per bbox -- see this file's header and `regions.ts`'s own `REGIONS_CACHE_KEY`. */
const MET_CACHE_KEY = 'met-alerts';

export interface WarningsRouteDependencies {
    /** The process-wide MET Alerts outbound budget (`app.ts`). A refusal is an ordinary upstream failure here: the same stale-then-absent path a real MET outage takes. */
    metGate?: OutboundGate | undefined;
    /** The process-wide NVE Varsom outbound budget, shared by the region roster fetch and every per-region warning fetch (`app.ts`). */
    nveGate?: OutboundGate | undefined;
}

/** `YYYY-MM-DD` for "today", in UTC. NVE updates a region's warning at most a few times a day, so a few hours' difference from Norway's own local midnight is not worth the complexity of a timezone-aware "today" -- the 1800s per-region cache TTL is a far bigger source of latency than this ever could be. */
function todayDateStr(): string {
    return new Date().toISOString().slice(0, 10);
}

export function registerWarningsRoutes(app: FastifyInstance, config: ServerConfig, dependencies: WarningsRouteDependencies = {}): void {
    const metCache = new TtlCache<RawMetFeature[]>(config.metAlertsCacheTtlMs);
    const regionWarningCache = new TtlCache<RawWarningEntry[]>(config.avalancheCacheTtlMs, { maxEntries: MAX_CACHED_REGION_WARNINGS });
    const regionsSource = createRegionsSource(config.avalancheRegionsCacheTtlMs, {
        upstreamTimeoutMs: config.upstreamTimeoutMs,
        gate: dependencies.nveGate,
    });

    app.get('/api/warnings', async (request, reply) => {
        const query = request.query as { bbox?: unknown };
        const parsed = parseBbox(query.bbox);
        if (!parsed.ok) {
            reply.code(400).send({ error: parsed.error.message });
            return;
        }

        const bbox = roundBbox(clampBbox(parsed.value));

        const metResult = await loadWithStaleFallback(metCache, MET_CACHE_KEY, (): Promise<Result<RawMetFeature[]>> =>
            fetchMetAlerts({
                upstreamTimeoutMs: config.upstreamTimeoutMs,
                userAgent: config.metUserAgent,
                gate: dependencies.metGate,
            }),
        );

        let weatherWarnings: WeatherWarning[] | null = null;
        let staleWeather = false;
        if (metResult.ok) {
            const mapped = mapMetAlerts(metResult.value, bbox);
            if (mapped.discarded > 0) {
                // The invisible failure this guards against: a renamed
                // MET field empties this half while the map reads "no
                // weather warnings right now" -- exactly what a genuinely
                // quiet spell looks like too. One warn per fetch, a count
                // only, no bbox: the same rule `transit.ts` follows.
                request.log.warn(
                    { discarded: mapped.discarded },
                    'MET Alerts records were discarded while mapping; fewer warnings are served than upstream sent',
                );
            }
            weatherWarnings = mapped.warnings;
            staleWeather = metResult.stale;
            if (metResult.stale) {
                request.log.error({ err: metResult.error }, 'MET Alerts fetch failed, serving a stale warnings answer for this viewport');
            }
        } else {
            request.log.error({ err: metResult.error }, 'MET Alerts fetch failed and no cached warnings answer exists for this viewport');
        }

        let avalancheWarnings: AvalancheWarning[] | null = null;
        let staleAvalanche = false;
        const regions = await regionsSource.get();
        if (!regions) {
            request.log.error('NVE region roster is unavailable; avalanche warnings cannot be served');
        } else {
            staleAvalanche = regions.stale;
            const dateStr = todayDateStr();
            const entries: AvalancheWarning[] = [];
            let attemptedRegions = 0;
            let failedRegions = 0;
            for (const hit of regionsIntersecting(regions.regions, bbox)) {
                attemptedRegions += 1;
                const regionResult = await loadWithStaleFallback(regionWarningCache, `${hit.region.regionId}:${dateStr}`, () =>
                    fetchRegionWarning(hit.region.regionId, dateStr, {
                        upstreamTimeoutMs: config.upstreamTimeoutMs,
                        gate: dependencies.nveGate,
                    }),
                );
                if (!regionResult.ok) {
                    // A per-region failure costs only that region's entry,
                    // not the whole avalanche half -- the same reasoning
                    // as a single malformed road situation or vehicle
                    // record not failing its whole batch. Only when EVERY
                    // attempted region fails below is that reasoning no
                    // longer enough (see the `failedRegions` check after
                    // this loop): a total per-region outage must not read
                    // as an empty, all-clear avalanche answer.
                    failedRegions += 1;
                    request.log.warn(
                        { err: regionResult.error, regionId: hit.region.regionId },
                        'NVE avalanche warning fetch failed for one region; it is omitted from this response',
                    );
                    continue;
                }
                staleAvalanche = staleAvalanche || regionResult.stale;
                const mapped = mapAvalancheWarning(regionResult.value, hit.region, hit.point);
                if (mapped) entries.push(mapped);
            }
            if (attemptedRegions > 0 && failedRegions === attemptedRegions) {
                // Every intersecting region's fetch failed with nothing
                // stale to fall back on -- this is a total NVE per-region
                // outage, indistinguishable in the loop above from a
                // genuinely quiet stretch, so it must report "unknown"
                // (`null`), not "no danger anywhere" (`[]`). Zero
                // intersecting regions (the `attemptedRegions === 0` case)
                // is a real, successful "nothing here" answer and must
                // stay `[]`.
                request.log.error('NVE avalanche warning fetch failed for every intersecting region; nothing can be served');
                avalancheWarnings = null;
            } else {
                avalancheWarnings = entries;
            }
        }

        if (weatherWarnings === null && avalancheWarnings === null) {
            request.log.error('warnings upstream fetch failed for both MET Alerts and NVE Varsom; nothing can be served');
            reply.code(502).send({ error: 'Upstream unavailable' });
            return;
        }

        const body: WarningsResponse = {
            configured: true,
            weatherWarnings,
            avalancheWarnings,
            fetchedAt: new Date().toISOString(),
        };

        // The shorter of the two halves' own TTLs: a response must never be
        // advertised as fresh for longer than its *most* volatile half
        // considers itself fresh.
        sendJson(reply, request, body, staleWeather || staleAvalanche, {
            maxAgeSeconds: cacheSeconds(Math.min(config.metAlertsCacheTtlMs, config.avalancheCacheTtlMs)),
        });
    });
}
