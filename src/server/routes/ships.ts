/**
 * `GET /api/ships?bbox=minLng,minLat,maxLng,maxLat` -- the live AIS ships
 * layer. Unlike every other proxy route in this app, ships have an
 * "unconfigured" state: with no `BARENTSWATCH_CLIENT_ID`/
 * `BARENTSWATCH_CLIENT_SECRET` set, the server still starts normally and
 * this route responds `503 {configured:false}` -- distinguishable from
 * "configured, but genuinely zero ships right now" (`200
 * {configured:true, ships: [], fetchedAt}`) by an unaware client or a
 * monitoring check.
 */
import type { FastifyInstance } from 'fastify';
import type { Ship, ShipsResponse } from '../../shared/schemas/ships.js';
import { bboxCacheKey, clampBbox, parseBbox, roundBbox } from '../layers/bbox.js';
import { fetchShips } from '../ships/barentswatch.js';
import { createBarentsWatchToken } from '../ships/token.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { serveCached } from '../route-helpers.js';
import type { TrailStore } from '../trails/store.js';

export interface ShipsRouteDependencies {
    /** The BFF's memory of recent positions (`src/server/trails/`). Every ship served carries its own recent trail from here, and when BarentsWatch is unreachable the store's last-known vessels are served in place of an error. */
    trails: TrailStore<Ship>;
}

/** Attaches each ship's remembered positions and stamps the response. */
function withTrails(ships: readonly Ship[], trails: TrailStore<Ship>, now: Date): Extract<ShipsResponse, { configured: true }> {
    return {
        configured: true,
        ships: ships.map((ship) => ({ ...ship, trail: trails.trailFor(ship.mmsi, now) })),
        fetchedAt: now.toISOString(),
    };
}

export function registerShipsRoutes(app: FastifyInstance, config: ServerConfig, dependencies: ShipsRouteDependencies): void {
    const configured = config.barentswatchClientId !== '' && config.barentswatchClientSecret !== '';
    // Only ever holds the `configured: true` variant -- typed as the full
    // union so it can be constructed/returned without a cast. Keyed
    // per-bbox (unlike the nesthus.no proxy routes' single fixed key), so
    // this gets its own TTL config field (`config.shipsCacheTtlMs`, >= 10s
    // in production) rather than sharing `config.cacheTtlMs`.
    const cache = new TtlCache<ShipsResponse>(config.shipsCacheTtlMs);
    const token = configured
        ? createBarentsWatchToken(config.barentswatchClientId, config.barentswatchClientSecret, config.upstreamTimeoutMs)
        : undefined;

    app.get('/api/ships', async (request, reply) => {
        const query = request.query as { bbox?: unknown };
        const parsed = parseBbox(query.bbox);
        if (!parsed.ok) {
            reply.code(400).send({ error: parsed.error.message });
            return;
        }

        const bbox = roundBbox(clampBbox(parsed.value));

        if (!configured || !token) {
            const body: ShipsResponse = { configured: false };
            reply.code(503).send(body);
            return;
        }

        await serveCached(request, reply, cache, bboxCacheKey(bbox), async () => {
            const result = await fetchShips(bbox, token, config.upstreamTimeoutMs);
            const now = new Date();

            if (result.ok) {
                // Recorded before responding, so a ship's own current fix is
                // part of its history the next time it is asked for -- a
                // browser polling a viewport contributes to the trails just
                // as the background poller does.
                dependencies.trails.record(result.value, now);
                return { ok: true, value: withTrails(result.value, dependencies.trails, now) };
            }

            // BarentsWatch is unreachable. A stale cached response for this
            // exact viewport is the better answer where one exists --
            // `serveCached` serves it verbatim and marks it `X-Cache:
            // stale` -- so only reach for the store when there is no cache
            // to fall back on. That is the case this covers: a cold load
            // during an outage, which would otherwise be a blank map.
            if (cache.get(bboxCacheKey(bbox))) return result;

            // The remembered vessels are minutes old at worst, each carries
            // its own fix timestamp, and the map fades and accounts for
            // stale vessels itself. An empty store means there is genuinely
            // nothing to say, so the error stands.
            const known = dependencies.trails.latestIn(bbox, now);
            if (known.length === 0) return result;
            request.log.warn({ reason: result.error.message, ships: known.length }, 'ships upstream failed; serving remembered vessels');
            return { ok: true, value: withTrails(known, dependencies.trails, now) };
        });
    });
}
