/**
 * `GET /api/map-config` -- a tiny, unauthenticated route exposing config
 * the frontend needs at runtime but the Docker build cannot bake in: the
 * multi-stage build's `npm run build` stage has no access to the running
 * container's `.env` (`docker-compose.yml`'s `env_file: .env` only
 * affects the container at run time, not `docker compose build`), so a
 * build-time-embedded env var would silently ship an empty key in every
 * production image. This route lets `MapPage.ts` fetch the real value
 * once, at runtime, instead.
 *
 * No auth in front of this, unlike `src/server/routes/settings.ts`'s
 * write surface -- `cartoApiKey` is meant to be public/client-visible
 * (like a Mapbox public token), not a server-only secret like
 * BarentsWatch's credentials.
 */
import type { FastifyInstance } from 'fastify';
import type { MapConfigResponse } from '../../shared/schemas/map-config.js';
import type { ServerConfig } from '../config.js';

export function registerMapConfigRoute(app: FastifyInstance, config: ServerConfig): void {
    app.get('/api/map-config', async (_request, reply) => {
        const body: MapConfigResponse = { cartoApiKey: config.cartoApiKey };
        reply.send(body);
    });
}
