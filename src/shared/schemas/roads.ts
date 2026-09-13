import { z } from 'zod';
import { IsoTimestampSchema, LatLngSchema } from './common.js';

/**
 * What kind of thing a road situation *is*, normalised from Statens
 * vegvesen's `SITUATION_TYPE` (`MaintenanceWorks`, `ConstructionWorks`,
 * `PoorEnvironmentConditions`, `TransitInformation`, `Accident`, ...).
 *
 * A closed set, so the map can pick a sign face and a colour without a
 * lookup table that has to grow every time upstream invents a type. The
 * raw value travels alongside in `rawType`, deliberately: the mapping is
 * lossy on purpose, and `other` must never mean "the data was thrown
 * away" -- a popup can still say what upstream actually called it.
 */
export const RoadSituationKindSchema = z.enum([
    'roadworks',
    'obstruction',
    'weather',
    'accident',
    'ferry',
    'event',
    /** A consequence-only situation: lights, manual direction, rerouting -- a management measure with no separate cause record. */
    'management',
    'other',
]);

export type RoadSituationKind = z.infer<typeof RoadSituationKindSchema>;

/**
 * Where a situation sits relative to "now", computed once server-side
 * (`src/server/roads/situations.ts`) rather than in each client.
 *
 * Only these three ever reach a client: a situation whose end time has
 * passed is dropped before this schema is reached, and one starting
 * beyond the planned horizon is never mapped at all.
 *
 *  - `current`   -- happening right now.
 *  - `scheduled` -- inside its overall window, but outside today's
 *    validity period (roadworks at 22:00 that run 08:00-21:00).
 *  - `planned`   -- starts in the future.
 *
 * The response carries all three and the *client* hides the latter two
 * unless `settings.roads.showPlanned`, so one cache entry serves both
 * preferences. It follows that the status is at most one cache TTL
 * stale, which is why the boundary cases are minutes-wide, not seconds.
 */
export const RoadSituationStatusSchema = z.enum(['current', 'scheduled', 'planned']);

export type RoadSituationStatus = z.infer<typeof RoadSituationStatusSchema>;

/**
 * One line of a situation's extent, as `[lat, lng]` pairs -- Leaflet's
 * own tuple order, so the web layer hands these straight to
 * `L.polyline`. Note that the WFS emits `[lng, lat]`; the swap happens
 * once, in the server-side mapper, and never again.
 *
 * Coordinates arrive simplified (Douglas-Peucker) and rounded to five
 * decimals: a single upstream feature can carry 497 points and 416 KB,
 * which is detail no 1024x600 kiosk can draw.
 *
 * At least two points, because one point is not a line. Simplification
 * really can collapse a short segment onto a single rounded coordinate,
 * and the server drops such a part rather than sending it -- this is the
 * contract saying so, so that neither side has to defend against a
 * polyline that would draw nothing.
 */
export const RoadLineSchema = z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(2);

export type RoadLine = z.infer<typeof RoadLineSchema>;

/**
 * The app's own normalised road situation -- one "vegmelding", NOT one
 * upstream record. Vegvesen publishes a situation as a main record (the
 * cause: roadworks, weather, an accident) plus N consequence records
 * (lane closures, speed limits, temporary lights) that share its
 * `SITUATION_ID` and repeat its geometry byte for byte. The server groups
 * them, so one of these is one pin on the map.
 *
 * `description` is Vegvesen's Norwegian text verbatim, in both UI
 * languages: the NPRA terms for this data state that the Norwegian
 * messages may not be translated. Upstream's `|` line breaks become
 * `\n` on the way through.
 */
export const RoadSituationSchema = z.object({
    /** Upstream's `SITUATION_ID` -- the grouping key, and what the map diffs markers by across polls. */
    id: z.string(),
    kind: RoadSituationKindSchema,
    /** Upstream's own `SITUATION_TYPE`, kept because `kind` is a deliberately lossy narrowing of it. */
    rawType: z.string(),
    /** Upstream's `SEVERITY` (`low`, `none`, `high`, `highest`, `unknown` as observed). A plain string, not an enum: it is passed through for display and ranking, and a value upstream adds later must not fail a response that is otherwise fine. */
    severity: z.string(),
    status: RoadSituationStatusSchema,
    /** `true` when any record in the group closes the road (`roadClosed` among `effects`). Drawn as the closure sign regardless of what caused it -- "shut" is the fact read across the room. */
    closed: z.boolean(),
    /** The union of every grouped record's secondary types and management types (`roadClosed`, `narrowLanes`, `temporaryTrafficLights`, ...), raw. Rendered as chips; unknown values simply show as themselves. */
    effects: z.array(z.string()),
    /** `E10`, `R85`, `F7542` as upstream writes it -- formatted for display ("Fv. 7542") in the web layer, not here. Null for the handful of records that carry none. */
    roadNumber: z.string().nullable(),
    location: z.string().nullable(),
    description: z.string(),
    startsAt: IsoTimestampSchema,
    /** Null means open-ended ("inntil videre"), which upstream does use. `startsAt` is never null. */
    endsAt: IsoTimestampSchema.nullable(),
    updatedAt: IsoTimestampSchema,
    /** `true` when the situation has validity periods ("08:00-21:00 weekdays"), i.e. it is not continuously in force between `startsAt` and `endsAt`. Drives both the "gyldig 08:30-21:00" popup line and the `scheduled` status. */
    periodic: z.boolean(),
    /** Where the pin goes: upstream's own display coordinates, present on every feature including the ones whose geometry is a line. */
    point: LatLngSchema,
    /**
     * The situation's extent, one entry per `LineString` (a
     * `MultiLineString` yields several). Null unless it is a closure or
     * roadworks *and* upstream's geometry is a line: a wind warning on a
     * bridge carries geometry too, but its extent tells a viewer nothing
     * a pin does not, and the bytes are better spent elsewhere.
     *
     * Null, never `[]`. "No extent to draw" has exactly one spelling
     * here, so a client can branch on `line === null` and be done --
     * including when every part of a `MultiLineString` collapsed under
     * simplification, which the server turns into null rather than an
     * empty list.
     */
    line: z.array(RoadLineSchema).min(1).nullable(),
});

export type RoadSituation = z.infer<typeof RoadSituationSchema>;

/**
 * Statens vegvesen's OGC GeoServer is keyless, so in practice this layer
 * is always `{configured:true}`. The discriminated union is kept anyway,
 * to match `ShipsResponseSchema`/`AircraftResponseSchema`: every live
 * layer's envelope reads the same way on both sides of the wire
 * (`LiveLayerSpec.schema` documents exactly this shape), and a future
 * upstream that does demand a credential -- or a deployment that wants
 * to switch the layer off server-side -- needs no contract change to say
 * so.
 */
export const RoadSituationsResponseSchema = z.discriminatedUnion('configured', [
    z.object({
        configured: z.literal(true),
        situations: z.array(RoadSituationSchema),
        fetchedAt: IsoTimestampSchema,
    }),
    z.object({
        configured: z.literal(false),
    }),
]);

export type RoadSituationsResponse = z.infer<typeof RoadSituationsResponseSchema>;
