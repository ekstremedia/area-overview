/**
 * The one place this app talks to MET Norway's Alerts API
 * (`api.met.no/weatherapi/metalerts/2.0/current.json`), for the warnings
 * layer's weather half. Keyless, but MET's terms of use require a
 * descriptive `User-Agent` identifying the caller (`config.metUserAgent`)
 * or the service throttles aggressively.
 *
 * Two things about this API were confirmed live on 2026-09-16 and are
 * pinned by tests rather than left to memory:
 *
 *  - **There is no server-side viewport filter.** `?county=`/`?lat=&lon=`
 *    both returned empty results during probing, but every active alert
 *    at probe time was a marine area with `county: []` -- that is NOT
 *    proof the filters work, only that there was nothing land-based to
 *    filter for. So this module always fetches the whole of Norway
 *    (`fetchMetAlerts` takes no bbox at all) and `mapMetAlerts` does the
 *    spatial filtering itself, against the rounded viewport bbox, using
 *    `warnings/geo.ts`.
 *  - **The colour is `riskMatrixColor`, not a hand-split
 *    `awareness_level`.** `awareness_level` is a semicolon-joined triple
 *    ("2; yellow; Moderate": level number, colour, name) that would need
 *    splitting and trimming to get the same colour `riskMatrixColor`
 *    already gives directly (`"Yellow"`, lower-cased once here). Preferred
 *    as the simpler, less ambiguous source; `awareness_level` is only
 *    parsed as a fallback for a hypothetical alert that carries the
 *    triple but not `riskMatrixColor`.
 *  - **There is no `eventStartingTime` field at all**, even though
 *    `eventEndingTime` exists (confirmed against 7 live alerts). The only
 *    place a start time appears is embedded in `title`, a free-text
 *    summary whose last two comma-separated segments are always the
 *    start and end ISO timestamps (e.g. `"Kuling, gult nivå, ... ,
 *    2026-09-15T22:00:00+00:00, 2026-09-16T07:00:00+00:00"` -- the second
 *    of those two matches `eventEndingTime` exactly in every alert
 *    probed). `extractStartsAt` pulls the *first* ISO timestamp out of
 *    `title` by regex rather than splitting on `,` (an area name could
 *    itself contain a comma) or trusting a fixed field count.
 *
 * Same shape as `roads/vegvesen-wfs.ts`/`transit/entur.ts`: an injected
 * `fetchImpl`, a shared outbound gate checked before anything is sent, and
 * a tolerant parse. Unlike those two, the mapper lives in this file too
 * (per the plan) rather than in its own module, since there is exactly one
 * caller and one shape to map onto.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';
import { WeatherWarningSchema, type WeatherWarning } from '../../shared/schemas/warnings.js';
import type { Bbox } from '../layers/bbox.js';
import type { OutboundGate } from '../outbound-gate.js';
import { ringIntersectsBbox, type Ring } from './geo.js';

export const MET_ALERTS_URL = 'https://api.met.no/weatherapi/metalerts/2.0/current.json';

/** Reported when the MET gate is shut, so a route can tell this apart from an upstream that actually failed. */
const GATE_CLOSED_MESSAGE = 'MET Alerts request skipped: outbound rate gate is closed';

/** GeoJSON's own `[lng, lat, ...]` position, never reordered until `ringFromPositions` swaps it once. */
const PositionSchema = z.tuple([z.number(), z.number()]).rest(z.number());
type RawPosition = z.infer<typeof PositionSchema>;

/**
 * `Polygon` (one probed live) and `MultiPolygon` (never seen, but a real
 * alert could plausibly be one -- handled defensively per the plan). Any
 * other geometry, or none at all, becomes `null` rather than a parse
 * failure: a feature this app cannot place still carries its other
 * attributes, and `mapMetAlerts` decides what an unplaceable alert costs.
 */
const RawGeometrySchema = z
    .union([
        z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(PositionSchema)) }),
        z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(z.array(PositionSchema))) }),
    ])
    .nullable()
    .catch(null);
type RawGeometry = z.infer<typeof RawGeometrySchema>;

const RawFeatureSchema = z.object({
    geometry: RawGeometrySchema.optional(),
    properties: z.record(z.string(), z.unknown()).nullable().catch(null),
});
export type RawMetFeature = z.infer<typeof RawFeatureSchema>;

const FeatureCollectionSchema = z.object({
    features: z.array(RawFeatureSchema).nullish(),
});

export interface FetchMetAlertsOptions {
    /** Bounded deadline for the request -- `config.upstreamTimeoutMs` in production. */
    upstreamTimeoutMs: number;
    /** MET's own terms-of-use requirement: `config.metUserAgent`. */
    userAgent: string;
    /** The process-wide MET outbound budget (`outbound-gate.ts`). */
    gate?: OutboundGate | undefined;
    fetchImpl?: typeof fetch;
}

/** Fetches the whole of Norway's active alerts. Mapping onto `WeatherWarning[]`, including the bbox filter, is `mapMetAlerts`'s job. */
export async function fetchMetAlerts(options: FetchMetAlertsOptions): Promise<Result<RawMetFeature[]>> {
    const fetchImpl = options.fetchImpl ?? fetch;

    // Checked before the request is built: a refusal must cost nothing.
    if (options.gate && !options.gate.tryTake()) {
        return err({ message: GATE_CLOSED_MESSAGE });
    }

    let response: Response;
    try {
        response = await fetchImpl(MET_ALERTS_URL, {
            headers: { 'User-Agent': options.userAgent, Accept: 'application/json' },
            signal: AbortSignal.timeout(options.upstreamTimeoutMs),
        });
    } catch {
        return err({ message: 'MET Alerts request failed (network error)' });
    }
    if (!response.ok) {
        return err({ message: `MET Alerts endpoint responded with status ${String(response.status)}` });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return err({ message: 'MET Alerts endpoint returned a non-JSON body' });
    }

    const parsed = FeatureCollectionSchema.safeParse(body);
    if (!parsed.success) {
        return err({ message: 'MET Alerts response failed schema validation', cause: parsed.error });
    }

    return ok(parsed.data.features ?? []);
}

/** The fields this app reads off one feature's `properties`, and nothing else. */
const RawPropertiesSchema = z.object({
    id: z.string(),
    event: z.string(),
    riskMatrixColor: z.string().nullish(),
    awareness_level: z.string().nullish(),
    eventAwarenessName: z.string(),
    description: z.string(),
    consequences: z.string().nullish(),
    instruction: z.string().nullish(),
    area: z.string().nullish(),
    // There is no `eventStartingTime` field -- confirmed against 7 live
    // alerts, all carrying `eventEndingTime` but nothing else time-related
    // except `title`. See this file's header and `extractStartsAt` below.
    title: z.string(),
    eventEndingTime: z.string().nullish(),
});
type RawProperties = z.infer<typeof RawPropertiesSchema>;

/**
 * The alert's awareness colour: `riskMatrixColor` verbatim, lower-cased,
 * or (only if that is absent) the middle segment of `awareness_level`'s
 * semicolon-joined triple. See this file's header for why the former is
 * preferred.
 */
function extractAwarenessLevel(properties: RawProperties): string | null {
    if (properties.riskMatrixColor && properties.riskMatrixColor.trim() !== '') {
        return properties.riskMatrixColor.trim().toLowerCase();
    }
    if (properties.awareness_level) {
        const segments = properties.awareness_level.split(';').map((segment) => segment.trim());
        const colour = segments[1];
        if (colour) return colour.toLowerCase();
    }
    return null;
}

/** Matches an ISO-8601 timestamp with an explicit offset (`Z` or `+HH:MM`/`-HH:MM`) -- the shape every `title` and `eventEndingTime` value was observed to use. */
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})/;

/** Every ISO-8601 timestamp embedded in `title`, in order of appearance. */
function extractTimestamps(title: string): string[] {
    return [...title.matchAll(new RegExp(ISO_TIMESTAMP_PATTERN, 'g'))].map((match) => match[0]);
}

/**
 * The alert's start time, embedded in `title` (see this file's header: MET
 * ships no dedicated start-time field at all). `title` is free text built
 * from several parts joined with `, `, and the area name -- one of those
 * parts -- could itself contain a comma, so this pulls out ISO-8601
 * timestamps by pattern rather than splitting on `,` and trusting a fixed
 * segment count.
 *
 * The header's own observation -- the *last* two timestamps in `title` are
 * always start and end, and the second matches `eventEndingTime` -- only
 * tells apart start from end when there are two. When `title` carries
 * exactly one timestamp, it is ambiguous whether that lone value is the
 * start or (mis-set) the end: if it equals `eventEndingTime`, it is almost
 * certainly the end time, not the start, and reporting it as `startsAt`
 * would be worse than reporting no start time at all. So a single
 * timestamp is only trusted as `startsAt` when it does NOT equal
 * `eventEndingTime`; otherwise (or when `title` carries no timestamp at
 * all) this returns `null`, which `mapMetAlerts` treats as a dropped alert
 * rather than fabricating a start time.
 */
function extractStartsAt(title: string, eventEndingTime: string | null | undefined): string | null {
    const timestamps = extractTimestamps(title);
    const first = timestamps[0];
    if (first === undefined) return null;
    if (timestamps.length === 1 && eventEndingTime !== null && eventEndingTime !== undefined && first === eventEndingTime) {
        return null;
    }
    return first;
}

/** GeoJSON's `[lng, lat, ...]` to this app's own `[lat, lng]`, the same swap `roads/situations.ts` does once for Vegvesen's coordinates. */
function ringFromPositions(positions: readonly RawPosition[]): Ring {
    return positions.map(([lng, lat]): [number, number] => [lat, lng]);
}

/**
 * The outer ring of every polygon part. Holes (a `Polygon`'s rings after
 * the first) are dropped: a weather hazard area is not expected to have
 * one, and this app's ring-array shape has no way to mark a ring as a hole
 * versus a disjoint part anyway (see `WeatherWarningSchema`'s own "one or
 * more rings" comment, which is about disjoint parts, not holes).
 */
function toRings(geometry: RawGeometry): Ring[] {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') {
        const outer = geometry.coordinates[0];
        return outer ? [ringFromPositions(outer)] : [];
    }
    const rings: Ring[] = [];
    for (const polygon of geometry.coordinates) {
        const outer = polygon[0];
        if (outer) rings.push(ringFromPositions(outer));
    }
    return rings;
}

export interface MapMetAlertsResult {
    warnings: WeatherWarning[];
    /** Features whose `properties` did not carry the fields this app reads, or whose mapped shape failed `WeatherWarningSchema` -- an upstream rename would show up here. Does not include features simply outside `bbox` or with no usable geometry at all: that is ordinary spatial filtering, not a fault. */
    discarded: number;
}

/**
 * Maps `features` (the whole of Norway) onto the `WeatherWarning[]` for one
 * viewport: keeps only alerts whose polygon actually intersects `bbox`,
 * drops what does not parse, and counts the latter into `discarded` so an
 * upstream rename is visible rather than reading as a quiet, warning-free
 * night.
 */
export function mapMetAlerts(features: readonly RawMetFeature[], bbox: Bbox): MapMetAlertsResult {
    const warnings: WeatherWarning[] = [];
    let discarded = 0;

    for (const feature of features) {
        const parsedProperties = RawPropertiesSchema.safeParse(feature.properties ?? {});
        if (!parsedProperties.success) {
            discarded += 1;
            continue;
        }
        const properties = parsedProperties.data;

        const rings = toRings(feature.geometry ?? null);
        // No usable geometry, or geometry that does not touch this
        // viewport at all: this layer places warnings on a map, so a
        // shapeless alert (rare; see `WeatherWarningSchema`'s nullable
        // `polygon`) or one entirely outside `bbox` is simply not part of
        // this response. Ordinary spatial filtering, not counted.
        if (rings.length === 0 || !rings.some((ring) => ringIntersectsBbox(ring, bbox))) continue;

        const awarenessLevel = extractAwarenessLevel(properties);
        if (!awarenessLevel) {
            discarded += 1;
            continue;
        }

        const startsAt = extractStartsAt(properties.title, properties.eventEndingTime);
        if (!startsAt) {
            discarded += 1;
            continue;
        }

        const candidate = {
            id: properties.id,
            event: properties.event,
            awarenessLevel,
            // Upstream's own `eventAwarenessName`, per
            // `WeatherWarningSchema.title`'s own contract -- not upstream's
            // `title` property, a different, free-text field this mapper
            // only reads for its embedded start time (see this file's
            // header and `extractStartsAt`).
            title: properties.eventAwarenessName,
            description: properties.description,
            consequences: properties.consequences ?? null,
            instruction: properties.instruction ?? null,
            area: properties.area ?? null,
            polygon: rings,
            startsAt,
            endsAt: properties.eventEndingTime ?? null,
        };

        const validated = WeatherWarningSchema.safeParse(candidate);
        if (validated.success) {
            warnings.push(validated.data);
        } else {
            discarded += 1;
        }
    }

    return { warnings, discarded };
}
