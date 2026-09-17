/**
 * Turns Entur's raw vehicle records into this app's transit vehicles.
 * Pure: no network, no clock of its own -- `now` and `maxAgeMinutes` are
 * passed in, so every response filters against the same instant and the
 * same requested window, and a test can pick both. Same split
 * `roads/situations.ts` uses for road situations: `entur.ts` hands back
 * untyped bags, and this is the only place that decides what a malformed
 * one costs.
 *
 * Three filters run here, and only one of them is a discard:
 *
 *  - **Mode.** Only `BUS` and `FERRY` map onto this layer (see
 *    `shared/schemas/transit.ts`'s header on why the contract is
 *    narrowed to those two). Every other `VehicleModeEnumeration` value
 *    is dropped -- this is the filter working as designed on every
 *    response, not a fault, so it is not counted into `discards`. Same
 *    rule `situations.ts` applies to an expired or too-far-future
 *    situation.
 *  - **Age.** A vehicle whose `lastUpdated` is older than `maxAgeMinutes`
 *    is dropped and IS counted (`stale`) -- this is the layer's whole
 *    reason for existing. Entur keeps a vehicle in the feed until its
 *    `expiration`, which live probing found sits 6-12 hours after
 *    `lastUpdated`, so without this filter the map would show parked
 *    buses all night.
 *  - **Attributes/contract.** A record missing a required field, or one
 *    whose mapped shape fails the shared schema, costs that record and
 *    is counted -- an upstream rename must show up as a warning, not as
 *    a quiet drop in vehicle count that reads exactly like a quiet
 *    night.
 */
import { z } from 'zod';
import { IsoTimestampSchema } from '../../shared/schemas/common.js';
import { TransitModeSchema, TransitVehicleSchema, type TransitVehicle } from '../../shared/schemas/transit.js';
import { DiscardTally } from './discards.js';
import type { RawVehicleRecord } from './entur.js';

const MS_PER_MINUTE = 60_000;

/** Entur's `VehicleModeEnumeration` values that map onto this layer, lower-cased for a case-insensitive match against upstream's own upper-case spelling. */
const MODE_BY_UPSTREAM_VALUE = new Map(TransitModeSchema.options.map((mode) => [mode.toUpperCase(), mode]));

/**
 * The fields this app reads off one raw vehicle record, and nothing
 * else. `location` is required -- a vehicle this app cannot place on the
 * map is not a vehicle it can show. `line`/`operator` are optional
 * objects: their own fields are read with `?? null` below rather than
 * required here, since a journey with neither a line nor an operator is
 * a plausible answer, not a malformed one.
 */
const RawVehicleSchema = z.object({
    vehicleId: z.string(),
    mode: z.string(),
    delay: z.number().nullish(),
    lastUpdated: IsoTimestampSchema,
    originName: z.string().nullish(),
    destinationName: z.string().nullish(),
    location: z.object({ latitude: z.number(), longitude: z.number() }),
    line: z
        .object({
            lineRef: z.string().nullish(),
            publicCode: z.string().nullish(),
            lineName: z.string().nullish(),
        })
        .nullish(),
    operator: z.object({ operatorRef: z.string().nullish() }).nullish(),
});

/**
 * Maps `records` onto `TransitVehicle[]`, dropping what this layer
 * cannot or should not show: a record whose attributes do not parse, a
 * mode other than bus/ferry, a fix older than `maxAgeMinutes`, and a
 * mapped record the shared contract refuses. Only the first, third and
 * fourth are counted into `discards` -- see this file's header.
 */
export function mapVehicles(
    records: readonly RawVehicleRecord[],
    now: Date,
    maxAgeMinutes: number,
    discards: DiscardTally = new DiscardTally(),
): TransitVehicle[] {
    const maxAgeMs = maxAgeMinutes * MS_PER_MINUTE;
    const vehicles: TransitVehicle[] = [];

    for (const record of records) {
        discards.seen();

        const parsed = RawVehicleSchema.safeParse(record ?? {});
        if (!parsed.success) {
            discards.discard('attributes');
            continue;
        }
        const raw = parsed.data;

        const mode = MODE_BY_UPSTREAM_VALUE.get(raw.mode.toUpperCase());
        if (!mode) continue; // Not a bus or a ferry -- the filter working, not a fault.

        const ageMs = now.getTime() - Date.parse(raw.lastUpdated);
        if (ageMs > maxAgeMs) {
            discards.discard('stale');
            continue;
        }

        const candidate = {
            id: raw.vehicleId,
            mode,
            line: raw.line?.lineName ?? null,
            publicCode: raw.line?.publicCode ?? null,
            // An empty string is a valid (if uninformative) `operatorRef` --
            // real ferry records carry one -- and is passed through as-is.
            // Only the absence of an `operator` object at all becomes `null`.
            operatorRef: raw.operator ? (raw.operator.operatorRef ?? null) : null,
            origin: raw.originName ?? null,
            destination: raw.destinationName ?? null,
            delaySeconds: raw.delay ?? null,
            point: { lat: raw.location.latitude, lng: raw.location.longitude },
            recordedAt: raw.lastUpdated,
        };

        const validated = TransitVehicleSchema.safeParse(candidate);
        if (validated.success) {
            vehicles.push(validated.data);
        } else {
            discards.discard('contract');
        }
    }

    return vehicles;
}
