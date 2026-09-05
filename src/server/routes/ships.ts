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
import type { ShipsResponse } from '../../shared/schemas/ships.js';
import { bboxCacheKey, clampBbox, parseBbox, roundBbox } from '../layers/bbox.js';
import { fetchShips } from '../ships/barentswatch.js';
import { createBarentsWatchToken } from '../ships/token.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import { serveCached } from '../route-helpers.js';

export function registerShipsRoutes(app: FastifyInstance, config: ServerConfig): void {
    const configured = config.barentswatchClientId !== '' && config.barentswatchClientSecret !== '';
    // Only ever holds the `configured: true` variant -- typed as the full
    // union so it can be constructed/returned without a cast. Keyed
    // per-bbox (unlike the nesthus.no proxy routes' single fixed key), so
    // this gets its own TTL config field (`config.shipsCacheTtlMs`, >= 10s
    // in production) rather than sharing `config.cacheTtlMs`.
    const cache = new TtlCache<ShipsResponse>(config.shipsCacheTtlMs);
    const token = configured ? createBarentsWatchToken(config.barentswatchClientId, config.barentswatchClientSecret) : undefined;

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
            const result = await fetchShips(bbox, token);
            if (!result.ok) return result;
            return { ok: true, value: { configured: true, ships: result.value, fetchedAt: new Date().toISOString() } };
        });
    });
}
