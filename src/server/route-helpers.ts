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
    /**
     * Emits `private` rather than `public` in `Cache-Control`.
     *
     * Set for a response whose content depended on the request's
     * credentials: a shared cache between this server and the browser
     * must never hand one visitor's authorised body to another visitor.
     */
    privateCache?: boolean;
    /**
     * Emits `Vary`, naming the request headers the body depended on.
     *
     * Without `Vary: Authorization` a cache is entitled to treat an
     * authorised and an unauthorised response as interchangeable, which
     * for the Netatmo gate would mean serving a logged-in body to the
     * open internet.
     */
    vary?: string;
}

/**
 * Applied to a cached value on its way out, per response.
 *
 * The cache holds one canonical document; this is what lets two responses
 * differ without two upstream calls. Because `sendJson` hashes the body it
 * is about to send, the `ETag` is automatically computed on the *served*
 * variant rather than on the cached one.
 *
 * Returning `null` means "this cannot be served" and produces a 502 --
 * used where serving the untransformed document would be wrong rather
 * than merely incomplete.
 */
export type ServeCachedTransform<T> = (value: T) => T | null | Promise<T | null>;

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
    if (options.vary !== undefined) {
        reply.header('Vary', options.vary);
    }
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
        const visibility = options.privateCache === true ? 'private' : 'public';
        reply.header(
            'Cache-Control',
            `${visibility}, max-age=${String(options.maxAgeSeconds)}, stale-while-revalidate=${String(STALE_WHILE_REVALIDATE_SECONDS)}`,
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
    options: ServeCachedOptions & { transform?: ServeCachedTransform<T> } = {},
): Promise<void> {
    try {
        const value = await cache.getOrLoad(key, async () => {
            const result = await fetcher();
            if (!result.ok) {
                throw new UpstreamFetchError(result.error);
            }
            return result.value;
        });
        const served = options.transform ? await options.transform(value) : value;
        if (served === null) {
            request.log.error(`transform for "${options.logKey ?? key}" refused to serve the cached document`);
            reply.code(502).send({ error: 'Upstream unavailable' });
            return;
        }
        sendJson(reply, request, served, false, options);
    } catch (error) {
        const logKey = options.logKey ?? key;
        const stale = cache.get(key);
        if (stale) {
            // The transform runs here too, and that is not a detail: the
            // cache holds the raw upstream document, so serving
            // `stale.value` directly would hand out exactly what the
            // transform exists to remove -- the Netatmo gate would leak
            // the station to everyone for the whole of an upstream
            // outage. A transform that refuses still means 502.
            // Wrapped: this runs inside the `catch` clause, so a transform
            // that rejects here would escape `serveCached` entirely and
            // reach Fastify's default handler as a 500 rather than the
            // controlled 502 below. `ServeCachedTransform` is allowed to
            // be async, so that is a reachable shape even though today's
            // two transforms do not reject.
            let staleServed: T | null;
            try {
                staleServed = options.transform ? await options.transform(stale.value) : stale.value;
            } catch (transformError) {
                request.log.error({ err: transformError }, `transform for "${logKey}" threw while serving the stale document`);
                reply.code(502).send({ error: 'Upstream unavailable' });
                return;
            }
            if (staleServed === null) {
                request.log.error({ err: error }, `upstream fetch for "${logKey}" failed and the stale document cannot be served either`);
                reply.code(502).send({ error: 'Upstream unavailable' });
                return;
            }
            request.log.error({ err: error }, `upstream fetch for "${logKey}" failed, serving stale cache`);
            sendJson(reply, request, staleServed, true, options.vary === undefined ? {} : { vary: options.vary });
            return;
        }

        request.log.error({ err: error }, `upstream fetch for "${logKey}" failed, no cached value available`);
        reply.code(502).send({ error: 'Upstream unavailable' });
    }
}
