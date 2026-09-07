/**
 * `GET /api/aircraft?bbox=minLng,minLat,maxLng,maxLat` -- the live ADS-B
 * aircraft layer. Unlike ships, aircraft need no credentials to be
 * "configured": `adsblol`/`airplaneslive`/`adsbfi` are all keyless, and
 * even `opensky` works anonymously (rate-limited) with no credentials --
 * so this route is always `{configured: true, ...}` on success,
 * regardless of `ADSB_PROVIDER`.
 */
import type { FastifyInstance } from 'fastify';
import type { Aircraft, AircraftResponse } from '../../shared/schemas/aircraft.js';
import { bboxCacheKey, clampBbox, parseBbox, roundBbox } from '../layers/bbox.js';
import { fetchAircraft } from '../aircraft/provider.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { serveCached } from '../route-helpers.js';
import type { TrailStore } from '../trails/store.js';

export interface AircraftRouteDependencies {
    /** See `ShipsRouteDependencies` in `routes/ships.ts` -- same contract, same reasons. */
    trails: TrailStore<Aircraft>;
}

/** Attaches each aircraft's remembered positions and stamps the response. */
function withTrails(aircraft: readonly Aircraft[], trails: TrailStore<Aircraft>, now: Date): Extract<AircraftResponse, { configured: true }> {
    return {
        configured: true,
        aircraft: aircraft.map((item) => ({ ...item, trail: trails.trailFor(item.icao, now) })),
        fetchedAt: now.toISOString(),
    };
}

export function registerAircraftRoutes(app: FastifyInstance, config: ServerConfig, dependencies: AircraftRouteDependencies): void {
    // Only ever holds the `configured: true` variant -- typed as the full
    // union so it can be constructed/returned without a cast; see the
    // matching comment in `routes/ships.ts`.
    const cache = new TtlCache<AircraftResponse>(config.aircraftCacheTtlMs);

    const openSkyCredentials =
        config.openskyClientId !== '' && config.openskyClientSecret !== ''
            ? { clientId: config.openskyClientId, clientSecret: config.openskyClientSecret }
            : undefined;

    if (config.adsbProvider === 'opensky' && !openSkyCredentials) {
        app.log.warn(
            "ADSB_PROVIDER=opensky with no OPENSKY_CLIENT_ID/SECRET set -- querying anonymously, subject to OpenSky's ~400 credit/day anonymous quota",
        );
    }

    app.get('/api/aircraft', async (request, reply) => {
        const query = request.query as { bbox?: unknown };
        const parsed = parseBbox(query.bbox);
        if (!parsed.ok) {
            reply.code(400).send({ error: parsed.error.message });
            return;
        }

        const bbox = roundBbox(clampBbox(parsed.value));

        await serveCached(request, reply, cache, bboxCacheKey(bbox), async () => {
            const result = await fetchAircraft(bbox, {
                provider: config.adsbProvider,
                openSkyCredentials,
                upstreamTimeoutMs: config.upstreamTimeoutMs,
            });
            const now = new Date();

            if (result.ok) {
                dependencies.trails.record(result.value, now);
                return { ok: true, value: withTrails(result.value, dependencies.trails, now) };
            }

            // Same reasoning as the ships route: prefer the stale cached
            // response where there is one, and reach for the store only on
            // a cold load during an outage, which would otherwise be a
            // blank layer.
            if (cache.get(bboxCacheKey(bbox))) return result;

            const known = dependencies.trails.latestIn(bbox);
            if (known.length === 0) return result;
            request.log.warn({ reason: result.error.message, aircraft: known.length }, 'aircraft upstream failed; serving remembered aircraft');
            return { ok: true, value: withTrails(known, dependencies.trails, now) };
        });
    });
}
