/**
 * Looks up a GBIF dataset's human-readable title
 * (`GET https://api.gbif.org/v1/dataset/{key}`) for the species layer's
 * "source dataset" popup line -- GBIF's occurrence search only ever
 * returns the dataset's UUID key on each record, never a title (confirmed
 * live, see `occurrences.ts`'s header).
 *
 * Cached VERY aggressively (`DATASET_TITLE_TTL_MS`, 30 days) in its own
 * `TtlCache`, keyed by dataset key -- a dataset's title essentially never
 * changes, so once any visitor's request resolves a key, every later
 * request across the whole process (any bbox, any species, any viewport)
 * reuses it for a month rather than re-fetching. Deliberately NOT gated by
 * the shared GBIF outbound budget (`outbound-gate.ts`): that budget exists
 * because occurrence search is keyed by viewport, which scales with
 * visitor traffic with no natural cap, whereas a dataset key lookup is
 * capped both by cardinality (a handful of distinct publishers turn up in
 * practice) and by this cache's own long TTL, so the realistic lifetime
 * call volume is a few dozen requests, not thousands.
 *
 * Fully non-blocking and fail-safe by construction: `lookupDatasetTitle`
 * never throws and is bounded by `timeoutMs` (`DATASET_TITLE_TIMEOUT_MS`
 * by default -- well under `config.upstreamTimeoutMs`, the main species
 * request's own budget). A slow, failed, or malformed response all fall
 * back to the key itself, so a flaky GBIF dataset endpoint can only
 * degrade the popup's title, never the species response as a whole.
 */
import { z } from 'zod';
import { TtlCache } from '../cache.js';

export const GBIF_DATASET_URL = 'https://api.gbif.org/v1/dataset';

/** Dataset titles essentially never change -- see this file's header. */
export const DATASET_TITLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Well under `config.upstreamTimeoutMs` -- a slow lookup must not eat into the main request's own budget. */
export const DATASET_TITLE_TIMEOUT_MS = 1500;

const DatasetSchema = z.object({ title: z.string().min(1).nullish() });

/** One process-wide cache, created once by the route and threaded through every lookup -- see this file's header on why the TTL is so long. */
export function createDatasetTitleCache(): TtlCache<string> {
    return new TtlCache<string>(DATASET_TITLE_TTL_MS, { maxEntries: 2000 });
}

export interface LookupDatasetTitleOptions {
    fetchImpl?: typeof fetch;
    /** Defaults to `DATASET_TITLE_TIMEOUT_MS`. */
    timeoutMs?: number;
    /** Same politeness convention as `gbif.ts`'s occurrence search -- typically `config.metUserAgent`. */
    userAgent: string;
}

/**
 * Resolves `key`'s title, or `key` itself on a cache miss that then
 * fails, times out, or comes back malformed -- see this file's header.
 * Never throws.
 */
export async function lookupDatasetTitle(key: string, cache: TtlCache<string>, options: LookupDatasetTitleOptions): Promise<string> {
    const cached = cache.get(key);
    if (cached) return cached.value; // Stale is fine here -- see this file's header on the 30-day TTL.

    const fetchImpl = options.fetchImpl ?? fetch;
    try {
        const response = await fetchImpl(`${GBIF_DATASET_URL}/${encodeURIComponent(key)}`, {
            headers: { Accept: 'application/json', 'User-Agent': options.userAgent },
            signal: AbortSignal.timeout(options.timeoutMs ?? DATASET_TITLE_TIMEOUT_MS),
        });
        if (!response.ok) return key;

        const body: unknown = await response.json();
        const parsed = DatasetSchema.safeParse(body);
        if (!parsed.success || !parsed.data.title) return key;

        cache.set(key, parsed.data.title);
        return parsed.data.title;
    } catch {
        return key; // Network error, timeout, or non-JSON body -- all the same fail-safe outcome.
    }
}
