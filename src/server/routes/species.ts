/**
 * `GET /api/species?bbox=minLng,minLat,maxLng,maxLat&days=N` -- GBIF
 * occurrence sightings for one viewport.
 *
 * Unlike `transit.ts`/`road-situations.ts`, GBIF's own `geometry` query
 * parameter already does the bbox filtering upstream (see
 * `species/gbif.ts`'s header) -- there is no client-side spatial
 * intersection here the way `warnings/met-alerts.ts` needs, so this route
 * caches the already-mapped response directly, the same simpler shape
 * `routes/aircraft.ts` uses, rather than caching raw records and
 * transforming them per request.
 *
 * The cache key carries `days` alongside the rounded bbox, since GBIF is
 * queried fresh per lookback window -- `?days=` is clamped to the nearest
 * of `settings.species.days`'s own four buckets (7/30/90/365) before it
 * ever reaches the cache key or the upstream query, so two nearby values
 * (`45` and `30`) share one cache entry and one upstream call rather than
 * each minting their own.
 *
 * The upstream is keyless, so in practice this route is always
 * `{configured: true, ...}` on success -- the envelope keeps the
 * discriminated union anyway, to read the same way as every other live
 * layer.
 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../../shared/result.js';
import type { SpeciesResponse } from '../../shared/schemas/species.js';
import { bboxCacheKey, clampBbox, parseBbox, roundBbox } from '../layers/bbox.js';
import { TtlCache } from '../cache.js';
import type { ServerConfig } from '../config.js';
import type { OutboundGate } from '../outbound-gate.js';
import { cacheSeconds, serveCached } from '../route-helpers.js';
import { createDatasetTitleCache, lookupDatasetTitle } from '../species/dataset-titles.js';
import { DiscardTally } from '../species/discards.js';
import { fetchGbifOccurrences } from '../species/gbif.js';
import { enrichDatasetTitles, mapOccurrences } from '../species/occurrences.js';

/** Four `days` buckets, each with its own rounded-bbox cache keyspace: a generous multiple of `transit.ts`'s own 64-viewport cap. */
const MAX_CACHED_ENTRIES = 256;

/** `settings.species.days`'s own closed bucket set -- kept local rather than importing the settings schema, to avoid this route depending on the settings module for four numbers. `settings/species.ts`'s `SpeciesDaysSchema` is the schema-level source of truth; this array must match it. */
const VALID_DAYS = [7, 30, 90, 365] as const;

/** `settings.species.days`'s own default (`shared/schemas/settings.ts`) -- used when the query string carries none or something unparseable. */
const DEFAULT_DAYS = 30;

export interface SpeciesRouteDependencies {
    /** The process-wide GBIF outbound budget (`app.ts`). A refusal is an ordinary upstream failure here: `serveCached` serves this viewport's stale answer, or 502 on a cold cache, the same path an upstream outage already takes. */
    gate?: OutboundGate | undefined;
}

/**
 * Parses `?days=`, clamped to the *nearest* of the four valid buckets --
 * never a 400, and never a value outside the closed set, so the cache key
 * stays bounded no matter what a visitor's URL carries. `45` and `30`
 * both clamp to `30` (`|45-30|=15` is the smallest distance to any
 * bucket), which is the exact case `routes/species.test.ts` pins: both
 * must produce the same cache key and cost one upstream call between them.
 */
export function parseDaysParam(raw: unknown): (typeof VALID_DAYS)[number] {
    // An empty string is not "unparseable" to `Number` -- `Number('')` is
    // `0`, a finite value -- so it must be turned away explicitly, before
    // ever reaching `Number()`, or it silently clamps to the 7-day bucket
    // instead of falling through to this function's own documented
    // default. Missing entirely (`undefined`, or any non-string query
    // value) already takes that path via the `typeof raw === 'string'`
    // check below.
    if (raw === '') return DEFAULT_DAYS;

    const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value)) return DEFAULT_DAYS;

    let nearest: (typeof VALID_DAYS)[number] = VALID_DAYS[0];
    let nearestDistance = Math.abs(value - nearest);
    for (const bucket of VALID_DAYS) {
        const distance = Math.abs(value - bucket);
        if (distance < nearestDistance) {
            nearest = bucket;
            nearestDistance = distance;
        }
    }
    return nearest;
}

export function registerSpeciesRoutes(app: FastifyInstance, config: ServerConfig, dependencies: SpeciesRouteDependencies = {}): void {
    // Only ever holds the `configured: true` variant -- typed as the full
    // union so it can be constructed/returned without a cast, matching
    // `routes/aircraft.ts`'s own cache.
    const cache = new TtlCache<SpeciesResponse>(config.speciesCacheTtlMs, { maxEntries: MAX_CACHED_ENTRIES });
    // Long-lived (30 days) and process-wide -- shared across every bbox
    // and `days` bucket, unlike `cache` above. See `species/dataset-titles.ts`'s header.
    const datasetTitleCache = createDatasetTitleCache();

    app.get('/api/species', async (request, reply) => {
        const query = request.query as { bbox?: unknown; days?: unknown };
        const parsed = parseBbox(query.bbox);
        if (!parsed.ok) {
            reply.code(400).send({ error: parsed.error.message });
            return;
        }

        const bbox = roundBbox(clampBbox(parsed.value));
        const days = parseDaysParam(query.days);
        const cacheKey = `${bboxCacheKey(bbox)}:${String(days)}`;

        await serveCached(
            request,
            reply,
            cache,
            cacheKey,
            async () => {
                const result = await fetchGbifOccurrences(bbox, days, new Date(), {
                    upstreamTimeoutMs: config.upstreamTimeoutMs,
                    userAgent: config.metUserAgent,
                    gate: dependencies.gate,
                });
                if (!result.ok) return result;

                const discards = new DiscardTally();
                const mapped = mapOccurrences(result.value.records, result.value.total, discards);

                // The invisible failure this guards against: a renamed
                // upstream field empties this layer while the map reads
                // "no sightings right now" -- exactly what a genuinely
                // quiet window looks like too. One warn per fetch, counts
                // only, no bbox: the same rule `transit.ts` follows.
                if (discards.dropped > 0) {
                    request.log.warn(
                        discards.summary(),
                        'GBIF occurrence records were discarded while mapping; the species layer is showing less than upstream sent',
                    );
                }

                // Non-blocking in spirit even though it's awaited here:
                // `lookupDatasetTitle` is bounded well under this route's
                // own upstream timeout and never rejects, so this can only
                // add a small bounded delay on a cache miss, never fail the
                // response -- see `species/dataset-titles.ts`'s header.
                const sightings = await enrichDatasetTitles(mapped.sightings, {
                    lookup: (key) => lookupDatasetTitle(key, datasetTitleCache, { userAgent: config.metUserAgent }),
                });

                return ok<SpeciesResponse>({
                    configured: true,
                    sightings,
                    truncated: mapped.truncated,
                    fetchedAt: new Date().toISOString(),
                });
            },
            {
                maxAgeSeconds: cacheSeconds(config.speciesCacheTtlMs),
                // The cache key embeds the rounded bbox, and `serveCached`
                // logs the key on every failure -- which would write a
                // stream of viewports into the container log through the
                // error path. The route's name says everything a log
                // reader needs, matching `transit.ts`.
                logKey: 'species',
            },
        );
    });
}
