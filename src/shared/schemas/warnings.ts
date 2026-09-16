import { z } from 'zod';
import { IsoTimestampSchema, LatLngSchema } from './common.js';

/**
 * One MET Alerts warning -- gale, storm surge, polar low, ice, forest fire,
 * and whatever else MET adds. `event` is upstream's own event string,
 * passed through rather than narrowed to a closed set: like
 * `RoadSituation.severity`, a value MET adds later must not fail an
 * otherwise-good response, and the map has no per-event branching that
 * would need a closed type -- only `awarenessLevel` picks the colour.
 * `awarenessLevel` itself is a plain string for the same reason: the map
 * needs a documented fallback colour for a `riskMatrixColor` it does not
 * recognise (Phase E), which is only possible if the server does not
 * already collapse an unfamiliar MET colour into a fixed few.
 */
export const WeatherWarningSchema = z.object({
    /** MET's own alert id -- the grouping key across polls. */
    id: z.string(),
    /** Upstream's event type (`gale`, `stormSurge`, `polarLow`, `ice`, `forestFire`, ...), passed through verbatim. */
    event: z.string(),
    /** MET's `riskMatrixColor`, passed through verbatim rather than narrowed to a closed set -- the client picks a marker colour from it and needs a documented fallback for a value it does not recognise. */
    awarenessLevel: z.string(),
    /** Upstream's `eventAwarenessName` -- the popup heading. */
    title: z.string(),
    /** MET's Norwegian advice text, verbatim -- shown in both UI languages, the same reasoning as `RoadSituation.description`. */
    description: z.string(),
    /** MET may omit either. Shown in the popup after `description`. */
    consequences: z.string().nullable(),
    instruction: z.string().nullable(),
    area: z.string().nullable(),
    /**
     * The warning area, as one or more rings of `[lat, lng]` pairs
     * (Leaflet's own tuple order, swapped once server-side same as
     * `RoadLine`) -- MET CAP areas can be a multi-polygon, so this is an
     * array of rings rather than a single one, the same shape
     * `RoadSituation.line` uses for its analogous multi-part case. Null
     * for the rare alert CAP ships with no polygon at all; each ring
     * still needs at least three points.
     */
    polygon: z.array(z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(3)).nullable(),
    startsAt: IsoTimestampSchema,
    endsAt: IsoTimestampSchema.nullable(),
});

export type WeatherWarning = z.infer<typeof WeatherWarningSchema>;

/**
 * Today's NVE Varsom danger level for one forecast region the map is
 * looking at. `dangerLevel` is 1-5 by NVE's own scale; out of season a
 * region simply does not appear in the list at all, never at level 0 --
 * "no warning" and "no data yet" both look like absence, which is the
 * correct reading for a wall display.
 */
export const AvalancheWarningSchema = z.object({
    /** NVE's own region id (`RegionId` in Varsom's API). */
    regionId: z.string(),
    regionName: z.string(),
    dangerLevel: z.number().int().min(1).max(5),
    validAt: IsoTimestampSchema,
    /** The region's own outline, `[lat, lng]` pairs, one ring -- every forecast region the viewport intersects draws as an outline, not just a pin. */
    outline: z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(3),
    /** The pin position: the centroid of this region's intersection with the viewport bbox, computed server-side -- not the region's own centroid, and not the outline. */
    point: LatLngSchema,
});

export type AvalancheWarning = z.infer<typeof AvalancheWarningSchema>;

/**
 * The Warnings layer's envelope: MET Alerts and NVE Varsom avalanche
 * warnings, merged into the one response this layer's one toggle and one
 * poll rate cover. Both upstreams are keyless, so `configured` is always
 * `true` in practice -- kept anyway to match every other live layer's
 * envelope shape.
 */
export const WarningsResponseSchema = z.discriminatedUnion('configured', [
    z.object({
        configured: z.literal(true),
        /** Null when MET Alerts failed to fetch this poll -- absent, not empty. A failure of either half must still serve the other. */
        weatherWarnings: z.array(WeatherWarningSchema).nullable(),
        /** Null when NVE Varsom failed to fetch this poll -- absent, not empty. */
        avalancheWarnings: z.array(AvalancheWarningSchema).nullable(),
        fetchedAt: IsoTimestampSchema,
    }),
    z.object({
        configured: z.literal(false),
    }),
]);

export type WarningsResponse = z.infer<typeof WarningsResponseSchema>;
