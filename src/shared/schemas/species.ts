import { z } from 'zod';
import { IsoTimestampSchema, LatLngSchema } from './common.js';

/**
 * One GBIF group -- a species reported at a place within the chosen
 * window, possibly several raw GBIF occurrence records folded into one
 * pin (same "one group is one pin" shape as `RoadSituation`, grouping
 * Vegvesen's main-plus-consequence records).
 *
 * `kingdom` is GBIF's own taxonomic kingdom (`Animalia`, `Plantae`,
 * `Fungi`, ...), passed through as a plain string rather than a closed
 * enum -- the same "display and filter on it, don't fail on a value GBIF
 * adds later" reasoning as `RoadSituation.severity`. The client's
 * `animalsOnly` filter (`settings.species.animalsOnly`) compares it
 * against `'Animalia'` verbatim.
 */
export const SightingSchema = z.object({
    /** The grouping key -- GBIF's `speciesKey` plus position rounded to three decimals, computed server-side. Not upstream's own occurrence id, which is per-record, and not date-bucketed: a group carries the newest `eventDate` across dates, so one group persists across polls rather than starting over each period. */
    id: z.string(),
    scientificName: z.string(),
    vernacularName: z.string().nullable(),
    kingdom: z.string(),
    /** GBIF's taxonomic class (`Aves`, `Mammalia`, `Actinopterygii`, `Insecta`, `Magnoliopsida`/`Pinopsida`, ...), passed through as a plain string -- separate from `kingdom`, which only serves the `animalsOnly` filter. */
    class: z.string(),
    /** The distinct dataset keys this group's records span, each with its human-readable title for the popup's "source dataset" line. A group can span more than one dataset. */
    datasets: z.array(z.object({ key: z.string(), title: z.string() })),
    /** The record's own licence, passed through to the popup. */
    license: z.string(),
    /** The coordinate uncertainty in metres, when a record in the group reports one; null otherwise. Shown in the popup when present. */
    coordinateUncertaintyMeters: z.number().nullable(),
    /** How many raw GBIF occurrence records this pin folds together -- record count, not individual count. At least one. */
    count: z.number().int().positive(),
    /** The summed `individualCount` across this group's records that reported one. Null when no record in the group had one -- distinct from `count`, which counts records regardless of whether they carried an individual count. */
    individualCount: z.number().int().positive().nullable(),
    point: LatLngSchema,
    /** The most recent record's observation date in this group. GBIF data lags reality by weeks; the map labels this fact, it does not hide it. */
    observedAt: IsoTimestampSchema,
});

export type Sighting = z.infer<typeof SightingSchema>;

/**
 * GBIF's occurrence search is keyless, so in practice this layer is
 * always `{configured:true}`. The discriminated union is kept anyway, to
 * match every other live layer's envelope.
 */
export const SpeciesResponseSchema = z.discriminatedUnion('configured', [
    z.object({
        configured: z.literal(true),
        sightings: z.array(SightingSchema),
        /** True when GBIF's own `count` exceeded the 400-group cap this response was fetched down to. */
        truncated: z.boolean(),
        fetchedAt: IsoTimestampSchema,
    }),
    z.object({
        configured: z.literal(false),
    }),
]);

export type SpeciesResponse = z.infer<typeof SpeciesResponseSchema>;
