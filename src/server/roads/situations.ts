/**
 * Turns Statens vegvesen's raw situation *records* into this app's road
 * situations. Pure: no network, no clock of its own -- `now` is passed
 * in, so every classification in one response is made against the same
 * instant and a test can pick that instant.
 *
 * Two pieces of upstream semantics drive everything here, both probed
 * live on 2026-09-13:
 *
 *  - **One situation is several records.** A "vegmelding" is published as
 *    one main record (the cause: `MaintenanceWorks`, `Accident`,
 *    `PoorEnvironmentConditions`, ...) plus N consequence records (lane
 *    closures, speed limits, temporary lights) that share its
 *    `SITUATION_ID` and repeat its geometry byte for byte -- 947 of 947
 *    multi-record situations did. Grouping is therefore not an
 *    optimisation: without it the map would show three pins in the same
 *    spot for one closed road.
 *  - **`ACTIVE` does not mean "happening now".** It is `1` only for a
 *    situation that has validity periods (`NUM_PERIODS > 0`, "08:00-21:00
 *    weekdays") and is inside one at this moment. 997 situations with no
 *    periods at all sit inside `START_TIME..END_TIME` carrying `ACTIVE=0`
 *    -- the wind warnings on Tjeldsundbrua among them. Reading `ACTIVE`
 *    as "current" would hide exactly the warnings this layer exists for.
 *    See `classifySituation`.
 */
import { z } from 'zod';
import { IsoTimestampSchema } from '../../shared/schemas/common.js';
import { RoadSituationSchema, type RoadSituation, type RoadSituationKind, type RoadSituationStatus } from '../../shared/schemas/roads.js';
import { simplifyLine, type LinePoint } from './simplify.js';
import type { RawFeature, RawGeometry } from './vegvesen-wfs.js';

/**
 * How far ahead a not-yet-started situation is worth carrying.
 *
 * Vegvesen publishes roadworks months out -- 773 of 2665 records probed
 * started in the future -- and "planned" on this map means "plan around
 * it", not "know about it". A fortnight is the horizon a trip is
 * actually decided within, and it keeps the planned pins from swamping
 * the current ones when `showPlanned` is on.
 */
export const PLANNED_HORIZON_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** Accepts the number, the numeric string and the boolean spellings of a flag/count; a JSON attribute bag is not a place to be sure which one arrives. */
const NumericSchema = z.union([z.number(), z.string(), z.boolean()]).nullish();

type Numeric = z.infer<typeof NumericSchema>;

function asNumber(value: Numeric): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const parsed = typeof value === 'number' ? value : Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}

/** A flag upstream may spell `1`, `"1"`, `true` or `"true"`. Anything else -- including `"0"` and absent -- is false, because this must never *promote* a record on a value nobody has seen. */
function asFlag(value: Numeric): boolean {
    if (typeof value === 'string' && value.trim().toLowerCase() === 'true') return true;
    return asNumber(value) === 1;
}

/** An identifier that arrives as a number in some rows and a string in others is still one identifier. */
const IdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));

/**
 * The attributes this app reads off one situation record. Everything
 * else upstream sends is dropped by Zod, and everything but the id, the
 * start time and the display coordinates is optional: a single record
 * missing an attribute must cost that record, never the response.
 *
 * Every name here is confirmed against `DescribeFeatureType` on
 * `datex_3_1:SituationSimple_v2` (2026-09-13). `LOCATION_DESCRIPTION` in
 * particular is the one the layer really has -- there is no `AREA_NAME`
 * or county attribute to fall back to, so no fallback is offered.
 */
const RawSituationPropsSchema = z.object({
    SITUATION_ID: IdSchema,
    SITUATION_TYPE: z.string().nullish(),
    /** Upstream's own cause/consequence flag -- see `mainRecordOf`. */
    IS_MAIN_RECORD: NumericSchema,
    SECONDARY_TYPES: z.string().nullish(),
    ROAD_OR_CARRIAGEWAY_OR_LANE_MANAGEMENT_TYPE: z.string().nullish(),
    SEVERITY: z.string().nullish(),
    DESCRIPTION: z.string().nullish(),
    ROAD_NUMBER: z.string().nullish(),
    LOCATION_DESCRIPTION: z.string().nullish(),
    START_TIME: IsoTimestampSchema,
    END_TIME: IsoTimestampSchema.nullish(),
    LAST_UPDATE_TIME: IsoTimestampSchema.nullish(),
    NUM_PERIODS: NumericSchema,
    ACTIVE: NumericSchema,
    COORDINATES_FOR_DISPLAY_LATITUDE: NumericSchema,
    COORDINATES_FOR_DISPLAY_LONGITUDE: NumericSchema,
});

export type RawSituationProps = z.infer<typeof RawSituationPropsSchema>;

/**
 * The record types that are *consequences* rather than causes.
 *
 * Only a fallback: upstream flags the cause record itself with
 * `IS_MAIN_RECORD`, and that flag is what `mainRecordOf` reads first.
 * This list decides a group where no record carries the flag -- and it
 * is also what makes `kind: 'management'` reachable, since a group of
 * nothing but consequences is a bare management measure (temporary
 * lights, manual direction, a diversion) with no cause record at all.
 */
const CONSEQUENCE_TYPES = new Set(
    ['RoadOrCarriagewayOrLaneManagement', 'SpeedManagement', 'GeneralNetworkManagement', 'ReroutingManagement', 'WinterDrivingManagement'].map(
        (type) => type.toLowerCase(),
    ),
);

/**
 * Upstream's `SITUATION_TYPE` narrowed onto the closed set the map can
 * draw a sign face for. Deliberately lossy -- the raw value travels on
 * in `rawType`, so `other` never means the data was thrown away, and an
 * unlisted type costs a generic sign rather than a dropped situation.
 */
const KIND_BY_TYPE = new Map<string, RoadSituationKind>(
    Object.entries({
        MaintenanceWorks: 'roadworks',
        ConstructionWorks: 'roadworks',
        RoadworksInformation: 'roadworks',
        PoorEnvironmentConditions: 'weather',
        PoorRoadConditions: 'weather',
        EnvironmentalObstruction: 'obstruction',
        GeneralObstruction: 'obstruction',
        AnimalPresenceObstruction: 'obstruction',
        VehicleObstruction: 'obstruction',
        InfrastructureDamageObstruction: 'obstruction',
        Accident: 'accident',
        TransitInformation: 'ferry',
        PublicEvent: 'event',
        RoadOrCarriagewayOrLaneManagement: 'management',
        SpeedManagement: 'management',
        GeneralNetworkManagement: 'management',
        ReroutingManagement: 'management',
        WinterDrivingManagement: 'management',
    } satisfies Record<string, RoadSituationKind>).map(([type, kind]) => [type.toLowerCase(), kind]),
);

function kindFor(rawType: string): RoadSituationKind {
    return KIND_BY_TYPE.get(rawType.toLowerCase()) ?? 'other';
}

function isConsequenceType(rawType: string | null | undefined): boolean {
    return rawType != null && CONSEQUENCE_TYPES.has(rawType.toLowerCase());
}

/** Trimmed text, or `null` for the three ways upstream spells "nothing here": absent, `null`, and an empty/whitespace string. */
function text(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? null : trimmed;
}

/**
 * Where a situation sits relative to `now`.
 *
 *  - `expired`   -- its end time has passed. Dropped by `mapSituations`.
 *  - `planned`   -- it has not started yet.
 *  - `scheduled` -- inside the overall window, but outside today's
 *    validity period: roadworks at 22:00 that run 08:00-21:00.
 *  - `current`   -- happening right now.
 *
 * The `ACTIVE` check is the subtle one, and it is deliberately written
 * as "periodic *and* not active", never as "not active": a situation
 * with no periods is in force for its whole window and carries
 * `ACTIVE=0` throughout. See this file's header.
 *
 * Expiry is tested before the future start, so a record with an end
 * before its own start (nonsense upstream, but cheap to be right about)
 * is dropped rather than shown as planned forever.
 */
export function classifySituation(props: RawSituationProps, now: Date): RoadSituationStatus | 'expired' {
    const nowMs = now.getTime();
    const startMs = Date.parse(props.START_TIME);
    const endMs = props.END_TIME == null ? null : Date.parse(props.END_TIME);

    // `END_TIME: null` is real and means open-ended ("inntil videre"), not
    // missing data -- 12 of 2665 records probed.
    if (endMs !== null && endMs < nowMs) return 'expired';
    if (startMs > nowMs) return 'planned';

    const periods = asNumber(props.NUM_PERIODS) ?? 0;
    const active = asNumber(props.ACTIVE) ?? 0;
    if (periods > 0 && active !== 1) return 'scheduled';

    return 'current';
}

/** `[lng, lat]` from the WFS becomes `[lat, lng]` for Leaflet. The single place this swap happens; everything downstream of here is already in Leaflet's order. */
function toLinePoints(coordinates: readonly (readonly number[])[]): LinePoint[] {
    const points: LinePoint[] = [];
    for (const position of coordinates) {
        const lng = position[0];
        const lat = position[1];
        if (lng === undefined || lat === undefined) continue;
        points.push([lat, lng]);
    }
    return points;
}

/**
 * A situation's extent, simplified, or `null` when the geometry is a
 * point (or something this app does not draw).
 *
 * Sub-lines that simplify down to a single point are dropped: a
 * `MultiLineString` does occasionally carry a degenerate part, and a
 * one-point polyline draws nothing while still costing a render.
 */
function lineFrom(geometry: RawGeometry | undefined): LinePoint[][] | null {
    if (geometry == null) return null;

    const rings =
        geometry.type === 'LineString'
            ? [toLinePoints(geometry.coordinates)]
            : geometry.type === 'MultiLineString'
              ? geometry.coordinates.map(toLinePoints)
              : null;
    if (rings === null) return null;

    const simplified = rings.map((ring) => simplifyLine(ring)).filter((ring) => ring.length >= 2);
    return simplified.length > 0 ? simplified : null;
}

/** The pin's position: upstream's own display coordinates, which every situation feature carries -- including the ones whose geometry is a 497-point line, where no vertex is a better choice than the one Vegvesen picked. */
function displayPoint(props: RawSituationProps, geometry: RawGeometry | undefined): { lat: number; lng: number } | null {
    const lat = asNumber(props.COORDINATES_FOR_DISPLAY_LATITUDE);
    const lng = asNumber(props.COORDINATES_FOR_DISPLAY_LONGITUDE);
    if (lat !== null && lng !== null) return { lat, lng };

    // Every probed feature had display coordinates, so this is the
    // belt-and-braces path: a point geometry is at least as good, and a
    // situation with neither cannot be placed and is dropped by the
    // caller.
    if (geometry?.type === 'Point') {
        return { lat: geometry.coordinates[1], lng: geometry.coordinates[0] };
    }
    return null;
}

/**
 * `|` is upstream's line break -- 2092 of 2665 descriptions carry at
 * least one. Each line is trimmed of the spaces that sit around the
 * separator, and nothing else is done to the text: NPRA's terms for this
 * data state that the Norwegian messages may not be translated, so it is
 * shown verbatim in both UI languages.
 *
 * An empty segment is kept, not dropped. `a||b` is a writer asking for a
 * blank line between two paragraphs, and silently closing it up is an
 * edit to text this app is not allowed to edit.
 */
function descriptionText(value: string | null | undefined): string {
    return (value ?? '')
        .split('|')
        .map((line) => line.trim())
        .join('\n');
}

/** Each record's `SECONDARY_TYPES` is a comma list; the management type is a single value on the consequence records. Both are passed through raw -- the map renders unknown effects as themselves. */
function effectsOf(props: RawSituationProps): string[] {
    const fromSecondary = (props.SECONDARY_TYPES ?? '')
        .split(',')
        .map((effect) => effect.trim())
        .filter((effect) => effect !== '');
    const management = text(props.ROAD_OR_CARRIAGEWAY_OR_LANE_MANAGEMENT_TYPE);
    return management === null ? fromSecondary : [...fromSecondary, management];
}

function locationOf(props: RawSituationProps): string | null {
    return text(props.LOCATION_DESCRIPTION);
}

interface ParsedRecord {
    props: RawSituationProps;
    geometry: RawGeometry | undefined;
}

/**
 * The situation's text: the main record's, falling back to the first
 * record in the group that has any.
 *
 * Worth the fallback because the split between cause and consequence is
 * upstream's editorial choice, not a rule -- a group can carry its only
 * readable sentence ("Vegen er stengt på grunn av ras") on the
 * consequence record, and an empty popup is the one thing a road notice
 * must never be.
 */
function groupDescription(main: ParsedRecord, records: readonly ParsedRecord[]): string {
    const own = descriptionText(main.props.DESCRIPTION);
    if (own.trim() !== '') return own;
    for (const record of records) {
        const description = descriptionText(record.props.DESCRIPTION);
        if (description.trim() !== '') return description;
    }
    return '';
}

/**
 * The record that speaks for the group.
 *
 * Upstream says so itself: `IS_MAIN_RECORD` flags the cause record, and
 * it is read first because the records do not arrive in any particular
 * order -- the situations query sorts by `LAST_UPDATE_TIME` descending,
 * so a consequence edited five minutes ago comes ahead of the cause it
 * belongs to.
 *
 * Without the flag (an older publication, a stripped `propertyName`
 * query) the record *type* decides, and a group of nothing but
 * consequence types falls through to its first record -- which is
 * exactly the bare management measure `kind: 'management'` describes.
 */
/** The first line geometry anywhere in the group, for the case where the main record happens not to carry one. */
function groupLine(records: readonly ParsedRecord[]): LinePoint[][] | null {
    for (const record of records) {
        const line = lineFrom(record.geometry);
        if (line !== null) return line;
    }
    return null;
}

function mainRecordOf(records: readonly ParsedRecord[]): ParsedRecord | undefined {
    return (
        records.find((record) => asFlag(record.props.IS_MAIN_RECORD)) ??
        records.find((record) => !isConsequenceType(record.props.SITUATION_TYPE)) ??
        records[0]
    );
}

/**
 * Groups records into situations and maps each onto the shared
 * `RoadSituation` shape, dropping what no client should be shown:
 * expired situations, ones starting beyond `PLANNED_HORIZON_DAYS`,
 * records whose attributes do not parse, and situations that cannot be
 * placed on the map at all.
 *
 * Order is upstream's own, which is `LAST_UPDATE_TIME` descending -- the
 * freshest situation first, and the one that survives if the 500-record
 * cap truncates the answer.
 */
export function mapSituations(features: readonly RawFeature[], now: Date): RoadSituation[] {
    const groups = new Map<string, ParsedRecord[]>();

    for (const feature of features) {
        const parsed = RawSituationPropsSchema.safeParse(feature.properties ?? {});
        if (!parsed.success) continue;
        const group = groups.get(parsed.data.SITUATION_ID);
        const record: ParsedRecord = { props: parsed.data, geometry: feature.geometry ?? null };
        if (group) {
            group.push(record);
        } else {
            groups.set(parsed.data.SITUATION_ID, [record]);
        }
    }

    const situations: RoadSituation[] = [];
    for (const [id, records] of groups) {
        // The main record is the cause, and gives the situation its kind,
        // its text and its window. See `mainRecordOf`.
        const main = mainRecordOf(records);
        if (!main) continue;

        const status = classifySituation(main.props, now);
        if (status === 'expired') continue;
        if (status === 'planned' && Date.parse(main.props.START_TIME) - now.getTime() > PLANNED_HORIZON_DAYS * MS_PER_DAY) continue;

        const point = displayPoint(main.props, main.geometry);
        if (!point) continue;

        const rawType = text(main.props.SITUATION_TYPE) ?? 'unknown';
        const kind = kindFor(rawType);
        const effects = [...new Set(records.flatMap((record) => effectsOf(record.props)))];
        const closed = effects.includes('roadClosed');

        // Lines are drawn for closures and roadworks only. A wind warning
        // on a bridge carries its geometry too, but its extent tells a
        // viewer nothing its pin does not -- and the bytes are better
        // spent on the situations whose *length* is the point.
        //
        // The main record's geometry first, then any record's: the probe
        // found the geometry repeated byte for byte across all 947
        // multi-record situations, so this only matters if that ever
        // stops being true -- and the cost of assuming it is a closure
        // drawn as a bare pin.
        const line = closed || kind === 'roadworks' ? (lineFrom(main.geometry) ?? groupLine(records)) : null;

        const updatedAt = records
            .map((record) => record.props.LAST_UPDATE_TIME)
            .filter((value): value is string => value != null)
            .reduce<string | null>((latest, value) => (latest === null || Date.parse(value) > Date.parse(latest) ? value : latest), null);

        const candidate = {
            id,
            kind,
            rawType,
            severity: text(main.props.SEVERITY) ?? 'unknown',
            status,
            closed,
            effects,
            roadNumber: text(main.props.ROAD_NUMBER),
            location: locationOf(main.props),
            description: groupDescription(main, records),
            startsAt: main.props.START_TIME,
            endsAt: main.props.END_TIME ?? null,
            updatedAt: updatedAt ?? main.props.START_TIME,
            periodic: (asNumber(main.props.NUM_PERIODS) ?? 0) > 0,
            point,
            line,
        };

        // The last gate before the wire: a nonsense coordinate (latitude
        // past +-90, longitude past +-180) or a timestamp that will not
        // parse fails here rather than reaching a client, and costs the
        // one situation rather than the viewport.
        //
        // It is NOT a check on the `[lng, lat]` swap, and must not be
        // mistaken for one: at this app's latitudes both numbers are
        // small (68.7 and 15.4), so a swap parses perfectly and simply
        // puts the pin in Kazakhstan. The swap is pinned directly, by
        // `situations.test.ts`'s "swaps upstream's [lng, lat] into
        // Leaflet's [lat, lng]".
        const validated = RoadSituationSchema.safeParse(candidate);
        if (validated.success) situations.push(validated.data);
    }

    return situations;
}
