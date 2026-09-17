/**
 * NVE Varsom's forecast region roster (`GET /Region`), for the warnings
 * layer's avalanche half: every region's id, name and polygon, fetched
 * once into a 24h `TtlCache` this module owns (`createRegionsSource`), and
 * the bbox-vs-region-polygon intersection `routes/warnings.ts` needs to
 * decide which regions to ask for today's warning.
 *
 * The regions endpoint is keyless, returns all ~46 regions in one ~350KB
 * answer (confirmed live 2026-09-16), and its geometry essentially never
 * changes -- a region boundary is a legal/administrative line, not
 * something that moves week to week. Hence caching it once a day rather
 * than per-bbox like every other layer's data.
 *
 * **`Polygon` is an array of strings, not an array of rings of numbers.**
 * Each string is a space-separated list of `"lat,lng"` pairs -- latitude
 * first, which for once matches this app's own `[lat, lng]` convention
 * rather than fighting it, but it is still a string that needs parsing,
 * not a coordinate-order trap. `parseOutline` does that once, here, so
 * every other consumer of `NveRegion` works with plain number tuples.
 *
 * A region's `Polygon` was only ever observed as a single-entry array
 * during probing, but the API shape allows more than one string (multiple
 * disjoint parts). `AvalancheWarningSchema.outline` is a single ring, so
 * `parseOutline` picks the longest one as the region's outline if more
 * than one is ever present -- a documented simplification, not a proven
 * real case.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';
import type { Bbox } from '../layers/bbox.js';
import { TtlCache } from '../cache.js';
import type { OutboundGate } from '../outbound-gate.js';
import { clipRingToBbox, ringCentroid, type Ring } from './geo.js';
import { loadWithStaleFallback } from './stale-cache.js';
import type { LatLng } from '../../shared/schemas/common.js';

export const NVE_REGIONS_URL = 'https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/Region';

/** Reported when the shared NVE gate is shut, so a route can tell this apart from an upstream that actually failed -- and, since the region roster and every per-region warning fetch share one gate, so a log line says which. */
const GATE_CLOSED_MESSAGE = 'NVE Region request skipped: outbound rate gate is closed';

const RawRegionSchema = z.object({
    Id: z.union([z.number(), z.string()]),
    Name: z.string(),
    TypeName: z.string().nullish(),
    Polygon: z.array(z.string()).nullish(),
});

export interface NveRegion {
    regionId: string;
    regionName: string;
    /** `"A"` (daily forecast region) or `"B"` (warned-on-demand). Not filtered on -- both are intersectable, per the plan. */
    typeName: string;
    /** The region's full outline, `[lat, lng]` tuples, one ring. */
    outline: Ring;
}

/** One `"lat,lng lat,lng ..."` string into `[lat, lng]` tuples. Malformed tokens (never seen live, cheap to be right about) are dropped rather than failing the whole ring. */
function parseRingString(value: string): Ring {
    const ring: Ring = [];
    for (const token of value.trim().split(/\s+/)) {
        if (token === '') continue;
        const [latPart, lngPart] = token.split(',');
        const lat = Number(latPart);
        const lng = Number(lngPart);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            ring.push([lat, lng]);
        }
    }
    return ring;
}

/** Picks the longest ring when `Polygon` carries more than one -- see this file's header. */
function parseOutline(polygon: readonly string[]): Ring {
    let best: Ring = [];
    for (const raw of polygon) {
        const ring = parseRingString(raw);
        if (ring.length > best.length) best = ring;
    }
    return best;
}

export interface FetchRegionsOptions {
    upstreamTimeoutMs: number;
    gate?: OutboundGate | undefined;
    fetchImpl?: typeof fetch;
}

/** Fetches every NVE Varsom forecast region. A region whose `Polygon` yields no usable ring (never seen live) is dropped -- it cannot be intersected against a bbox or drawn as an outline, so it is not a region this layer can do anything with. */
export async function fetchRegions(options: FetchRegionsOptions): Promise<Result<NveRegion[]>> {
    const fetchImpl = options.fetchImpl ?? fetch;

    if (options.gate && !options.gate.tryTake()) {
        return err({ message: GATE_CLOSED_MESSAGE });
    }

    let response: Response;
    try {
        response = await fetchImpl(NVE_REGIONS_URL, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(options.upstreamTimeoutMs),
        });
    } catch {
        return err({ message: 'NVE Region request failed (network error)' });
    }
    if (!response.ok) {
        return err({ message: `NVE Region endpoint responded with status ${String(response.status)}` });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return err({ message: 'NVE Region endpoint returned a non-JSON body' });
    }

    const parsed = z.array(RawRegionSchema).safeParse(body);
    if (!parsed.success) {
        return err({ message: 'NVE Region response failed schema validation', cause: parsed.error });
    }

    const regions: NveRegion[] = [];
    for (const raw of parsed.data) {
        const outline = parseOutline(raw.Polygon ?? []);
        if (outline.length < 3) continue;
        regions.push({ regionId: String(raw.Id), regionName: raw.Name, typeName: raw.TypeName ?? '', outline });
    }

    // NVE always has ~46 regions in practice -- a genuinely empty roster
    // (`parsed.data.length === 0`) never happens, but is still a valid
    // answer if it ever did (nothing to serve is not the same as garbage).
    // A NON-empty raw roster that maps down to zero usable regions,
    // though, means every entry was missing or had a too-short `Polygon`
    // -- a degraded/malformed upstream answer, not "NVE has no regions
    // today" -- and must not be read as the latter: the caller would
    // otherwise make zero region-intersection attempts and confidently
    // report "no avalanche warnings anywhere", indistinguishable from a
    // real all-clear.
    if (parsed.data.length > 0 && regions.length === 0) {
        return err({ message: 'NVE Region response parsed but yielded no usable regions (every entry lacked a usable Polygon)' });
    }

    return ok(regions);
}

/** One region the requested bbox actually touches, and where its avalanche pin belongs. */
export interface RegionIntersection {
    region: NveRegion;
    /** The centroid of `region.outline ∩ bbox`, per `AvalancheWarningSchema.point`'s own contract -- not the region's own centroid. */
    point: LatLng;
}

/** Every region in `regions` whose outline intersects `bbox`, each paired with the centroid of that intersection. Regions with no overlap are simply absent -- an empty result is a normal answer for a bbox far from any forecast region, not an error. */
export function regionsIntersecting(regions: readonly NveRegion[], bbox: Bbox): RegionIntersection[] {
    const hits: RegionIntersection[] = [];
    for (const region of regions) {
        const clipped = clipRingToBbox(region.outline, bbox);
        if (clipped.length < 3) continue;
        hits.push({ region, point: ringCentroid(clipped) });
    }
    return hits;
}

/** Reads the current (possibly stale) region roster, or `undefined` if none has ever been fetched successfully and the latest attempt just failed too. */
export interface RegionsSource {
    get(): Promise<{ regions: NveRegion[]; stale: boolean } | undefined>;
}

/** A fixed key: one nationwide roster, not one per bbox like every other layer's cache. */
const REGIONS_CACHE_KEY = 'nve-regions';

/**
 * Builds the region roster's own 24h cache with stale-on-failure and lazy
 * retry: a fresh call after the TTL lapses tries NVE again on its own (no
 * background timer), and a failed attempt falls back to whatever was
 * fetched before rather than losing the roster entirely -- the region
 * geometry a bbox is intersected against does not need to be fresh to the
 * minute, so serving yesterday's copy while NVE is unreachable is the
 * right trade.
 */
export function createRegionsSource(cacheTtlMs: number, options: FetchRegionsOptions): RegionsSource {
    const cache = new TtlCache<NveRegion[]>(cacheTtlMs);

    return {
        async get() {
            const result = await loadWithStaleFallback(cache, REGIONS_CACHE_KEY, () => fetchRegions(options));
            if (!result.ok) return undefined;
            return { regions: result.value, stale: result.stale };
        },
    };
}
