/**
 * `GET /healthz` -- a fast liveness/readiness probe. It never touches any
 * of the proxy caches (a healthz poll must not itself count as, or
 * compete with, a cached/proxied request) and validates nothing: it only
 * cares whether upstream answers at all, not whether its body is
 * well-formed.
 *
 * Reachability is checked with a short, capped-timeout `HEAD` request to
 * upstream's own root, independent of `config.upstreamTimeoutMs` so a
 * slow-but-configured-generous upstream timeout doesn't make `/healthz`
 * itself slow.
 */
import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../../shared/version.js';
import type { ServerConfig } from '../config.js';

const HEALTHZ_TIMEOUT_MS = 2000;

async function probeUpstream(upstreamBaseUrl: string): Promise<'reachable' | 'unreachable'> {
    try {
        const response = await fetch(upstreamBaseUrl, {
            method: 'HEAD',
            signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
        });
        return response.ok ? 'reachable' : 'unreachable';
    } catch {
        return 'unreachable';
    }
}

export function registerHealthzRoute(app: FastifyInstance, config: ServerConfig): void {
    app.get('/healthz', async (_request, reply) => {
        const upstream = await probeUpstream(config.upstreamBaseUrl);
        reply.send({ ok: true, upstream, version: APP_VERSION });
    });
}
