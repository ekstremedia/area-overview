/**
 * How many vehicle records `transit/vehicles.ts` refused, and why -- the
 * transit-layer counterpart of `roads/discards.ts` (see its header for
 * the full rationale: a mapper that quietly drops a record it cannot
 * parse is the right behaviour and also the dangerous one, because an
 * upstream field rename empties the layer while the map reads "no buses
 * right now", which is exactly what a genuinely quiet night looks like
 * too).
 *
 * A separate module from `roads/discards.ts` rather than a shared one:
 * the two mappers refuse records for different reasons. `stale` has no
 * road equivalent -- a road situation has a validity window, not a fix
 * age -- and `imageHost` has no transit equivalent at all. Sharing one
 * closed vocabulary between them would only grow the two apart.
 *
 * **Only unexpected drops are counted.** A vehicle that is neither a bus
 * nor a ferry is the mode filter working as designed, on every response,
 * and is not counted -- see `vehicles.ts`.
 */

/**
 * Why a record was refused. A closed vocabulary, because these strings
 * end up in the container log and are what someone greps for.
 *
 *  - `attributes` -- the raw record did not parse: a required field
 *    (`vehicleId`, `mode`, `lastUpdated`, `location`) was missing or the
 *    wrong shape. If this is most of `total`, an upstream field was
 *    renamed.
 *  - `stale` -- the vehicle's own `lastUpdated` is older than the
 *    requested max age. The whole reason this layer filters at all:
 *    Entur keeps a vehicle in the feed until `expiration`, hours after
 *    its last real fix, so without this filter the map would show parked
 *    buses all night.
 *  - `contract` -- the mapped record failed the shared schema on the way
 *    out. A bug on this side of the wire, or a value upstream should not
 *    have sent.
 */
export type DiscardReason = 'attributes' | 'stale' | 'contract';

/** A tally flattened for a log line: how many records were seen, how many were refused, and the refusals by reason (non-zero reasons only, so the line stays short). */
export interface DiscardSummary {
    records: number;
    dropped: number;
    reasons: Partial<Record<DiscardReason, number>>;
}

/** The out-parameter `mapVehicles` counts into. Passed in rather than returned, matching `roads/discards.ts`'s `DiscardTally` -- see its header for why. */
export class DiscardTally {
    private records = 0;
    private refused = 0;
    private readonly byReason = new Map<DiscardReason, number>();

    /** One more record looked at. */
    seen(): void {
        this.records += 1;
    }

    /** One record refused, for a reason worth telling apart from the others. */
    discard(reason: DiscardReason): void {
        this.refused += 1;
        this.byReason.set(reason, (this.byReason.get(reason) ?? 0) + 1);
    }

    /** How many records were refused; non-zero is the condition a route logs on. */
    get dropped(): number {
        return this.refused;
    }

    /** How many records the mapper looked at. */
    get total(): number {
        return this.records;
    }

    summary(): DiscardSummary {
        return { records: this.records, dropped: this.refused, reasons: Object.fromEntries(this.byReason) };
    }
}
