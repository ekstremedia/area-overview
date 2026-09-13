/**
 * The one place this app talks to Statens vegvesen's OGC GeoServer
 * (`ogckart-sn1.atlas.vegvesen.no`), for both road situations and road
 * cameras. Keyless: the licence (NLOD) explicitly says no user
 * registration is needed, so there is no token dance here at all -- only
 * a URL, a timeout and a tolerant parse.
 *
 * Two things about this service are traps, both probed live on
 * 2026-09-13 and both pinned by tests rather than left to memory:
 *
 *  - **`bbox` is `minLng,minLat,maxLng,maxLat,EPSG:4326`.** The lat-first
 *    axis order the WFS specification suggests for EPSG:4326 does not
 *    error -- it silently matches *nothing* (0 hits versus 54 for
 *    Vesterålen). A reversed bbox therefore looks exactly like "no
 *    roadworks anywhere near you", which is a plausible answer and so
 *    would never be noticed. `wfsQuery` is the only thing that builds it,
 *    and `vegvesen-wfs.test.ts` asserts the literal string.
 *  - The **output** coordinates are `[lng, lat]` (ordinary GeoJSON), while
 *    everything this app hands Leaflet is `[lat, lng]`. The swap happens
 *    once, in `roads/situations.ts`, and never again.
 *
 * Only WFS 2.0.0 is served, GeoJSON only via
 * `outputFormat=application/json`, and the server sends no
 * `Cache-Control`/`ETag` of its own -- all freshness policy is this
 * app's, in the routes' `TtlCache`.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';
import type { Bbox } from '../layers/bbox.js';
import type { OutboundGate } from '../outbound-gate.js';

export const VEGVESEN_WFS_URL = 'https://ogckart-sn1.atlas.vegvesen.no/ows';

/** The flat `_v2` layers. The non-`_v2` ones wrap a nested Datex object per record, which carries the same data behind another level of indirection; these are deliberate. */
export const SITUATIONS_TYPE_NAME = 'datex_3_1:SituationSimple_v2';
export const CCTV_TYPE_NAME = 'datex_3_1:CctvSimple_v2';
export const WEATHER_TYPE_NAME = 'datex_3_1:WeatherSimple_v2';

/**
 * The most situation *records* one viewport may ask for, newest first.
 *
 * A 2°x2° box over a city can hold far more than a kiosk can draw, and a
 * nationwide answer is 3 MB; Vesterålen is 54 records. Paired with
 * `sortBy=LAST_UPDATE_TIME D` so that what survives a truncation is the
 * freshest rather than an arbitrary page, and the routes log when the cap
 * is actually reached -- a silently truncated viewport is the one failure
 * mode of this design that no user could ever see.
 */
export const SITUATION_RECORD_LIMIT = 500;

/** The extra query parameters the situations layer is asked with. Cameras and weather stations need neither: there are 890 and 464 of them nationwide. Frozen, because it is module state handed to a function that merges it into a mutable bag. */
export const SITUATION_QUERY_EXTRA: Readonly<Record<string, string>> = Object.freeze({
    count: String(SITUATION_RECORD_LIMIT),
    sortBy: 'LAST_UPDATE_TIME D',
});

const USER_AGENT = 'area-overview-bff/0.1';

/** Reported when the shared Vegvesen gate is shut, so a route can tell this apart from an upstream that actually failed -- and, since both road routes share one gate, so a log line says which. */
export const GATE_CLOSED_MESSAGE = 'Vegvesen WFS request skipped: outbound rate gate is closed';

/** `[lng, lat]`, possibly with an elevation the WFS sometimes carries. Never reordered here -- see this file's header. */
const PositionSchema = z.tuple([z.number(), z.number()]).rest(z.number());

export type RawPosition = z.infer<typeof PositionSchema>;

/**
 * The three geometry types this app knows what to do with. Anything else
 * -- and a feature with no geometry at all, which the WFS does emit --
 * becomes `null` rather than a parse failure: every situation feature
 * also carries its own display coordinates, so an unknown geometry costs
 * a line on the map, not the whole response.
 *
 * `.catch(null)` is doing that work, and it is the only place in this
 * module where a malformed value is swallowed instead of reported.
 */
const RawGeometrySchema = z
    .union([
        z.object({ type: z.literal('Point'), coordinates: PositionSchema }),
        z.object({ type: z.literal('LineString'), coordinates: z.array(PositionSchema) }),
        z.object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(PositionSchema)) }),
    ])
    .nullable()
    .catch(null);

export type RawGeometry = z.infer<typeof RawGeometrySchema>;

/**
 * One GeoJSON feature, with its attributes left as an untyped bag.
 *
 * Deliberately untyped at this layer: the three layers this module
 * fetches share nothing but `properties`, and each consumer
 * (`situations.ts`, `road-cameras.ts`) validates exactly the fields it
 * reads and tolerates the rest. A strict schema here would turn one
 * unexpected attribute anywhere in a 500-record answer into an empty map.
 *
 * `properties` is `.catch(null)` for the same reason `geometry` is: a
 * feature with no attribute bag at all, or one that is not an object,
 * becomes a feature this app's mappers skip -- not a collection that
 * fails and takes the other 499 records with it.
 */
const RawFeatureSchema = z.object({
    geometry: RawGeometrySchema.optional(),
    properties: z.record(z.string(), z.unknown()).nullable().catch(null),
});

export type RawFeature = z.infer<typeof RawFeatureSchema>;

const FeatureCollectionSchema = z.object({
    features: z.array(RawFeatureSchema).nullish(),
});

/**
 * The query string for one GetFeature call.
 *
 * `bbox` is the trap this function exists to contain -- see the header.
 * `extra` is merged last, so a caller can add `count`/`sortBy` (the
 * situations layer does) and, in principle, override the fixed
 * parameters too. Not guarded against: both call sites pass a module
 * constant, never anything derived from a request, so a guard here would
 * only be code no test could justify.
 */
export function wfsQuery(typeName: string, bbox: Bbox, extra?: Readonly<Record<string, string>>): URLSearchParams {
    const params = new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: typeName,
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        // Longitude first. Not a style choice: the other order returns an
        // empty, entirely valid-looking answer.
        bbox: `${String(bbox.minLng)},${String(bbox.minLat)},${String(bbox.maxLng)},${String(bbox.maxLat)},EPSG:4326`,
    });
    for (const [key, value] of Object.entries(extra ?? {})) {
        params.set(key, value);
    }
    return params;
}

export interface FetchFeaturesOptions {
    /** Bounded deadline, always `config.upstreamTimeoutMs` in production -- same contract as `upstream.ts` and `aircraft/provider.ts`. */
    upstreamTimeoutMs: number;
    /**
     * The process-wide Statens vegvesen budget (`outbound-gate.ts`),
     * shared by `/api/road-situations` and `/api/road-cameras` because
     * the GeoServer sees one caller -- this app -- however many visitors
     * have the map open. A refusal is reported as an ordinary `Result`
     * error so the route takes the same stale-then-502 path an upstream
     * outage already takes.
     */
    gate?: OutboundGate | undefined;
    fetchImpl?: typeof fetch;
    /** Merged into the query string (`count`, `sortBy`). */
    extra?: Readonly<Record<string, string>> | undefined;
}

/** Fetches one layer's features inside `bbox`. Returns the raw features; mapping onto this app's own shapes is each consumer's job. */
export async function fetchFeatures(typeName: string, bbox: Bbox, options: FetchFeaturesOptions): Promise<Result<RawFeature[]>> {
    const fetchImpl = options.fetchImpl ?? fetch;

    // Checked before the request is built: a refusal must cost nothing.
    if (options.gate && !options.gate.tryTake()) {
        return err({ message: GATE_CLOSED_MESSAGE });
    }

    const url = `${VEGVESEN_WFS_URL}?${wfsQuery(typeName, bbox, options.extra).toString()}`;

    let response: Response;
    try {
        response = await fetchImpl(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(options.upstreamTimeoutMs),
        });
    } catch {
        return err({ message: `Vegvesen WFS request for "${typeName}" failed (network error)` });
    }
    if (!response.ok) {
        return err({ message: `Vegvesen WFS "${typeName}" responded with status ${String(response.status)}` });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return err({ message: `Vegvesen WFS "${typeName}" returned a non-JSON body` });
    }

    const parsed = FeatureCollectionSchema.safeParse(body);
    if (!parsed.success) {
        return err({ message: `Vegvesen WFS "${typeName}" response failed schema validation`, cause: parsed.error });
    }

    return ok(parsed.data.features ?? []);
}
