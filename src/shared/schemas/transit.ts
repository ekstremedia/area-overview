import { z } from 'zod';
import { IsoTimestampSchema, LatLngSchema } from './common.js';

/**
 * The two Entur vehicle kinds this layer draws. Entur's SIRI-VM feed
 * reports several `VehicleMode` values (`bus`, `ferry`, `rail`, `metro`,
 * `tram`, `coach`, ...) across the whole country; Vesterålen's own traffic
 * is buses and the road-replacing car ferries, so this contract is
 * narrowed to those two on purpose rather than left open -- an unfamiliar
 * mode reaching this schema is a bbox gone wrong, not a new feature to
 * silently draw.
 */
export const TransitModeSchema = z.enum(['bus', 'ferry']);

export type TransitMode = z.infer<typeof TransitModeSchema>;

/**
 * One Entur-reported vehicle -- a bus or a ferry, identified by its own
 * `VehicleRef`. Unlike `RoadSituation`, this is a position fix: `recordedAt`
 * is what `settings.transit.maxAgeMinutes` filters on, the same way
 * `ships`/`aircraft` do.
 */
export const TransitVehicleSchema = z.object({
    /** Entur's `VehicleRef` -- the identity the map diffs markers by across polls. */
    id: z.string(),
    mode: TransitModeSchema,
    /** Upstream's `PublishedLineName` -- the full line name (e.g. "Sortland-Stm.nes-Melbu-Svolvær"), shown in the popup. Not `publicCode`. Null for the rare journey that carries none. */
    line: z.string().nullable(),
    /** Upstream's `PublicCode` -- the short line number (e.g. "754") shown as the pin text. A different field from `line`/`lineName`. Null for the rare journey that carries none. */
    publicCode: z.string().nullable(),
    /** Upstream's `OperatorRef`. Shown in the popup when not empty -- empty string and null both mean absent; the client checks for both. */
    operatorRef: z.string().nullable(),
    origin: z.string().nullable(),
    destination: z.string().nullable(),
    /** Seconds late (negative means running early). Null when upstream reports no estimate for this fix. */
    delaySeconds: z.number().nullable(),
    point: LatLngSchema,
    /** Upstream's `RecordedAtTime` for this fix -- what `maxAgeMinutes` filters on. */
    recordedAt: IsoTimestampSchema,
});

export type TransitVehicle = z.infer<typeof TransitVehicleSchema>;

/**
 * Entur's realtime API is keyless (an `ET-Client-Name` header identifies
 * the caller, not a credential), so in practice this layer is always
 * `{configured:true}`. The discriminated union is kept anyway, matching
 * `RoadSituationsResponseSchema`: every live layer's envelope reads the
 * same way on both sides of the wire.
 */
export const TransitResponseSchema = z.discriminatedUnion('configured', [
    z.object({
        configured: z.literal(true),
        vehicles: z.array(TransitVehicleSchema),
        fetchedAt: IsoTimestampSchema,
    }),
    z.object({
        configured: z.literal(false),
    }),
]);

export type TransitResponse = z.infer<typeof TransitResponseSchema>;
