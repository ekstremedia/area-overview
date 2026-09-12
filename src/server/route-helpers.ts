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

export interface ServeCachedOptions {
    /**
     * Emits `Cache-Control: public, max-age=<n>, stale-while-revalidate=60`.
     * Worth having now that there are many clients rather than one kiosk:
     * the ETag/304 path underneath already makes a repeat poll cheap, but
     * only after a round trip, and `max-age` removes the round trip too.
     * Derived from each route's own TTL by its caller, so a cached
     * response is never advertised as fresh for longer than this server
     * would itself consider it fresh. Omitted, no header is sent.
     */
    maxAgeSeconds?: number;
    /**
     * What a failure is logged as, when the cache key itself must not be.
     *
     * The point-forecast keys embed the visitor's coordinates, so logging
     * the key would write positions into the container log through the
     * error path -- undoing the same promise `app.ts`'s request serializer
     * keeps on the success path. Defaults to `key`, which is right for
     * every route whose key is a fixed name.
     */
    logKey?: string;
}

/**
 * A window for revalidating in the background after `max-age` lapses.
 * Short on purpose: this is live data, and a browser reusing a response
 * for a minute while it refetches is the most staleness worth accepting.
 */
const STALE_WHILE_REVALIDATE_SECONDS = 60;

/**
 * A route's own TTL as whole seconds, for `Cache-Control: max-age`.
 * Rounded DOWN, and never below 1: advertising a response as fresh for
 * longer than this server considers it fresh would let a browser sit on
 * data the BFF has already replaced, and `max-age=0` would throw away the
 * saved round trip this header exists for.
 */
export function cacheSeconds(ttlMs: number): number {
    return Math.max(1, Math.floor(ttlMs / 1000));
}

function sendJson(reply: FastifyReply, request: FastifyRequest, value: unknown, stale: boolean, options: ServeCachedOptions = {}): void {
    const body = JSON.stringify(value);
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`;

    reply.header('ETag', etag);
    if (stale) {
        reply.header('X-Cache', 'stale');
        // `no-cache` (store it, but revalidate before every reuse) rather
        // than simply omitting the header. Two reasons, and the second is
        // the subtle one:
        //
        // - This body is one the server has already given up on, so a
        //   browser must come back and ask before showing it again.
        // - A `304` below would otherwise be actively harmful. Per RFC
        //   9111 a 304 *updates the stored response's headers*, and a
        //   stored copy from when this route was fresh still carries the
        //   `max-age` sent then. Saying nothing leaves that `max-age` in
        //   place, so a revalidation that learns the data is stale would
        //   hand the client another full freshness lifetime of it.
        reply.header('Cache-Control', 'no-cache');
    } else if (options.maxAgeSeconds !== undefined) {
        reply.header(
            'Cache-Control',
            `public, max-age=${String(options.maxAgeSeconds)}, stale-while-revalidate=${String(STALE_WHILE_REVALIDATE_SECONDS)}`,
        );
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
    options: ServeCachedOptions = {},
): Promise<void> {
    try {
        const value = await cache.getOrLoad(key, async () => {
            const result = await fetcher();
            if (!result.ok) {
                throw new UpstreamFetchError(result.error);
            }
            return result.value;
        });
        sendJson(reply, request, value, false, options);
    } catch (error) {
        const logKey = options.logKey ?? key;
        const stale = cache.get(key);
        if (stale) {
            request.log.error({ err: error }, `upstream fetch for "${logKey}" failed, serving stale cache`);
            sendJson(reply, request, stale.value, true);
            return;
        }

        request.log.error({ err: error }, `upstream fetch for "${logKey}" failed, no cached value available`);
        reply.code(502).send({ error: 'Upstream unavailable' });
    }
}
