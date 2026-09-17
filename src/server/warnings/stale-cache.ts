/**
 * The one piece of caching logic shared by every warnings data source that
 * needs "serve stale on failure, never let one bad poll blank a response
 * that used to have data": `routes/warnings.ts`'s per-bbox MET Alerts
 * cache, its per-region avalanche-warning cache, and `regions.ts`'s
 * once-a-day region roster.
 *
 * This exists as its own module because `/api/warnings` cannot use
 * `route-helpers.ts`'s `serveCached` the way every other layer does:
 * `serveCached` is built around ONE cache and ONE upstream fetch per
 * response, and this route merges TWO independently-fetchable,
 * independently-failable upstreams (MET Alerts, NVE Varsom) into one
 * envelope. Holding both behind a single cache/fetch would mean a MET
 * failure could blank the avalanche half too (or vice versa) just because
 * they happened to share one `TtlCache.getOrLoad` call -- exactly the
 * failure this layer's contract (`WarningsResponseSchema`'s header) rules
 * out. So each provider gets its own `TtlCache` and its own call to
 * `loadWithStaleFallback` below, and `routes/warnings.ts` combines the two
 * outcomes into one response afterwards. `regions.ts` uses the same
 * function for its own single-upstream cache, since the fallback logic is
 * identical -- there is nothing warnings-route-specific about it.
 */
import type { Result } from '../../shared/result.js';
import type { TtlCache } from '../cache.js';

/**
 * `ok:true` either because the fetch succeeded (`stale:false`, no `error`),
 * or because it failed and a previously-cached value was served instead
 * (`stale:true`, `error` set to what the fresh attempt failed with, for
 * the caller to log). `ok:false` only when the fetch failed and nothing
 * was ever cached for this key -- there is truly nothing to serve. A
 * failure is never swallowed silently; this module has no logger of its
 * own to log it with, so the caller always gets it back.
 */
export type LoadResult<T> =
    { ok: true; value: T; stale: false } | { ok: true; value: T; stale: true; error: unknown } | { ok: false; error: unknown };

/**
 * Loads `key` from `cache`, calling `fetcher` on a miss or expiry. On
 * failure, falls back to whatever `cache` still holds for `key` (however
 * stale) rather than propagating the failure -- mirrors `serveCached`'s own
 * fallback (`route-helpers.ts`), but returns the outcome instead of
 * writing an HTTP response, since neither warnings provider owns the
 * response on its own.
 */
export async function loadWithStaleFallback<T>(cache: TtlCache<T>, key: string, fetcher: () => Promise<Result<T>>): Promise<LoadResult<T>> {
    try {
        const value = await cache.getOrLoad(key, async () => {
            const result = await fetcher();
            if (!result.ok) {
                throw new Error(result.error.message, { cause: result.error.cause });
            }
            return result.value;
        });
        return { ok: true, value, stale: false };
    } catch (error) {
        const stale = cache.get(key);
        if (stale) {
            return { ok: true, value: stale.value, stale: true, error };
        }
        return { ok: false, error };
    }
}
