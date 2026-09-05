/**
 * A tiny in-memory, `Map`-backed TTL cache. There is no persistence and no
 * eviction beyond overwrite-on-`set` -- this is intentional for phase 2
 * (see the plan's non-goals): a restart clears everything, which is fine
 * for data this short-lived.
 *
 * Two behaviours routes depend on:
 *
 * - Stale-while-revalidate reads: an expired entry is not deleted, so a
 *   caller can still read it (tagged `stale: true`) to serve as a fallback
 *   while a fresh fetch is attempted.
 * - Single-flight loads: concurrent `getOrLoad` calls for the same key
 *   while a load is already in flight share that one promise instead of
 *   each triggering their own upstream call.
 */

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

export interface CacheReadResult<T> {
    value: T;
    stale: boolean;
}

export class TtlCache<T> {
    private readonly store = new Map<string, CacheEntry<T>>();
    private readonly inflight = new Map<string, Promise<T>>();

    constructor(private readonly ttlMs: number) {}

    /** Returns the entry for `key` regardless of freshness, or `undefined` if never set. */
    get(key: string): CacheReadResult<T> | undefined {
        const entry = this.store.get(key);
        if (!entry) {
            return undefined;
        }
        return { value: entry.value, stale: Date.now() >= entry.expiresAt };
    }

    set(key: string, value: T): void {
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }

    /**
     * Returns the fresh cached value for `key` if one exists; otherwise
     * calls `loader` to produce one, caching the result on success. A
     * failed load rejects and leaves any existing (stale) entry in place
     * for the caller to fall back to via `get`.
     */
    async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
        const cached = this.get(key);
        if (cached && !cached.stale) {
            return cached.value;
        }

        const existingLoad = this.inflight.get(key);
        if (existingLoad) {
            return existingLoad;
        }

        const load = loader()
            .then((value) => {
                this.set(key, value);
                return value;
            })
            .finally(() => {
                this.inflight.delete(key);
            });

        this.inflight.set(key, load);
        return load;
    }
}
