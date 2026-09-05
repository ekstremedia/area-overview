/**
 * Shared plumbing used by every proxy route (`weather`, `aurora`, `tide`,
 * `cameras`): read-through caching with single-flight upstream fetches,
 * stale-on-error fallback, and ETag/304 handling. Keeping this in one
 * place means each route file only has to describe *which* upstream path
 * and schema it uses, not how caching/ETags work.
 */
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError, Result } from '../shared/result.js';
import type { TtlCache } from './cache.js';

/** Wraps an `ApiError` in a real `Error` so it can be thrown/caught through `TtlCache.getOrLoad`. */
class UpstreamFetchError extends Error {
    readonly apiError: ApiError;

    constructor(apiError: ApiError) {
        super(apiError.message);
        this.name = 'UpstreamFetchError';
        this.apiError = apiError;
    }
}

function sendJson(reply: FastifyReply, request: FastifyRequest, value: unknown, stale: boolean): void {
    const body = JSON.stringify(value);
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`;

    reply.header('ETag', etag);
    if (stale) {
        reply.header('X-Cache', 'stale');
    }

    if (request.headers['if-none-match'] === etag) {
        reply.code(304).send();
        return;
    }

    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.send(body);
}

/**
 * Serves `key` from `cache`, loading it via `fetcher` on a miss/expiry
 * (single-flighted by the cache itself). On a load failure, falls back to
 * a stale cached value (tagged with `X-Cache: stale`) if one exists;
 * otherwise responds `502` with the failure logged, never forwarding a
 * malformed or missing body to the browser.
 */
export async function serveCached<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    cache: TtlCache<T>,
    key: string,
    fetcher: () => Promise<Result<T>>,
): Promise<void> {
    try {
        const value = await cache.getOrLoad(key, async () => {
            const result = await fetcher();
            if (!result.ok) {
                throw new UpstreamFetchError(result.error);
            }
            return result.value;
        });
        sendJson(reply, request, value, false);
    } catch (error) {
        const stale = cache.get(key);
        if (stale) {
            request.log.error({ err: error }, `upstream fetch for "${key}" failed, serving stale cache`);
            sendJson(reply, request, stale.value, true);
            return;
        }

        request.log.error({ err: error }, `upstream fetch for "${key}" failed, no cached value available`);
        reply.code(502).send({ error: 'Upstream unavailable' });
    }
}
