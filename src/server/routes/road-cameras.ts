/**
 * `GET /api/road-cameras?bbox=minLng,minLat,maxLng,maxLat` -- Statens
 * vegvesen's road cameras for one viewport, with the road weather
 * measured where they stand.
 *
 * A separate route from `/api/road-situations`, behind the same single
 * "Veg" toggle, and that split is deliberate. The camera list barely
 * changes (the pictures refresh in the browser, which costs this API
 * nothing), so it gets a five-minute TTL against the notices' two
 * minutes -- fewer outbound calls than one combined route, and a
 * camera-side outage cannot blank the road notices.
 *
 * Unlike ships, aircraft and road situations this response carries no
 * `configured` discriminator: the upstream is keyless and there is no
 * unconfigured state to report. See `shared/schemas/road-cameras.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../../shared/result.js';
import type { RoadCamerasResponse } from '../../shared/schemas/road-cameras.js';
import { bboxCacheKey, clampBbox, parseBbox, roundBbox } from '../layers/bbox.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import type { OutboundGate } from '../outbound-gate.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { fetchRoadCameras } from '../roads/road-cameras.js';

/** Matches `routes/ships.ts` and `routes/aircraft.ts` -- same reasoning, same number. */
const MAX_CACHED_VIEWPORTS = 64;

export interface RoadCamerasRouteDependencies {
    /** The process-wide Statens vegvesen budget, shared with `/api/road-situations` (`app.ts`). A refusal takes the same stale-then-502 path an upstream outage does. */
    gate?: OutboundGate | undefined;
}

export function registerRoadCamerasRoutes(app: FastifyInstance, config: ServerConfig, dependencies: RoadCamerasRouteDependencies = {}): void {
    const cache = new TtlCache<RoadCamerasResponse>(config.roadCamerasCacheTtlMs, { maxEntries: MAX_CACHED_VIEWPORTS });

    app.get('/api/road-cameras', async (request, reply) => {
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
                const result = await fetchRoadCameras(bbox, {
                    upstreamTimeoutMs: config.upstreamTimeoutMs,
                    gate: dependencies.gate,
                    // The pictures are the point; the temperatures under
                    // them are not worth failing a response over. Logged
                    // rather than swallowed, so a permanently missing
                    // weather layer is still visible in the logs.
                    onWeatherFailure: (message) => {
                        request.log.warn({ reason: message }, 'road weather unavailable; serving road cameras without readings');
                    },
                });
                if (!result.ok) return result;

                return ok<RoadCamerasResponse>({
                    cameras: result.value.cameras,
                    weatherBySite: result.value.weatherBySite,
                    fetchedAt: new Date().toISOString(),
                });
            },
            {
                maxAgeSeconds: cacheSeconds(config.roadCamerasCacheTtlMs),
                // Keeps the rounded bbox -- this route's cache key -- out
                // of the log on an upstream failure. See the matching
                // note in `road-situations.ts`.
                logKey: 'road-cameras',
            },
        );
    });
}
