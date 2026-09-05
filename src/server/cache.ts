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

export interface TtlCacheOptions {
    /**
     * Caps the number of distinct keys the cache holds at once, evicting the
     * least-recently-used entry (by `get`/`set` access, not by TTL) before
     * inserting a new key past the cap. Left unset for caches keyed by a
     * small, fixed set of route names -- those can never grow unbounded.
     * The point-forecast cache needs this: it is keyed by rounded lat/lng
     * (up to ~648 million distinct pairs at 2-decimal precision) behind a
     * public, unauthenticated endpoint (`/api/weather`), so without a cap a
     * client hitting many distinct coordinates could grow it without bound.
     */
    maxEntries?: number;
}

export class TtlCache<T> {
    // `Map` iterates in insertion order, and both `get` and `set` below
    // re-insert the touched key so it moves to the end -- the front of the
    // map is therefore always the least-recently-used key, which is what
    // `evictIfOverCapacity` evicts.
    private readonly store = new Map<string, CacheEntry<T>>();
    private readonly inflight = new Map<string, Promise<T>>();
    private readonly maxEntries: number | undefined;

    constructor(
        private readonly ttlMs: number,
        options: TtlCacheOptions = {},
    ) {
        this.maxEntries = options.maxEntries;
    }

    /** Returns the entry for `key` regardless of freshness, or `undefined` if never set. */
    get(key: string): CacheReadResult<T> | undefined {
        const entry = this.store.get(key);
        if (!entry) {
            return undefined;
        }
        this.store.delete(key);
        this.store.set(key, entry); // mark most-recently-used
        return { value: entry.value, stale: Date.now() >= entry.expiresAt };
    }

    set(key: string, value: T): void {
        this.store.delete(key); // re-setting an existing key also refreshes its LRU position
        this.evictIfOverCapacity();
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }

    private evictIfOverCapacity(): void {
        if (this.maxEntries === undefined || this.store.size < this.maxEntries) {
            return;
        }
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
            this.store.delete(oldestKey);
        }
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
