/**
 * How many raw GBIF occurrence records `species/occurrences.ts` refused,
 * and why -- the species-layer counterpart of `transit/discards.ts` and
 * `roads/discards.ts` (see either header for the full rationale: a mapper
 * that quietly drops a record it cannot parse is the right behaviour and
 * also the dangerous one, because an upstream field rename empties the
 * layer while the map reads "no sightings right now", which is exactly
 * what a genuinely quiet window looks like too).
 *
 * A separate module from the other two rather than a shared one, for the
 * same reason `transit/discards.ts` gives: this mapper refuses records for
 * reasons the other two have no equivalent of at all (`missingSpeciesKey`,
 * `missingEventDate`), and sharing one closed vocabulary between mappers
 * that refuse for different reasons would only grow them apart later.
 */

/**
 * Why a record was refused. A closed vocabulary, because these strings end
 * up in the container log and are what someone greps for.
 *
 *  - `attributes` -- the raw record did not parse against the fields this
 *    app reads, or was missing both `scientificName` and
 *    `acceptedScientificName`, or was missing its own coordinate. If this
 *    is most of `total`, an upstream field was renamed.
 *  - `missingSpeciesKey` -- the record carries no `speciesKey` at all, so
 *    it cannot be grouped meaningfully (the grouping key is
 *    `speciesKey` + rounded position). Distinct from `attributes` because
 *    it is expected to happen sometimes (a genus-level identification),
 *    not only on an upstream break.
 *  - `missingEventDate` -- the record carries no `eventDate`, so it cannot
 *    honestly claim a "recent sightings" date. Mirrors how
 *    `transit/vehicles.ts` discards a record missing `lastUpdated`.
 *  - `contract` -- the mapped group failed the shared schema on the way
 *    out. A bug on this side of the wire, or a value upstream should not
 *    have sent.
 */
export type DiscardReason = 'attributes' | 'missingSpeciesKey' | 'missingEventDate' | 'contract';

/** A tally flattened for a log line: how many records were seen, how many were refused, and the refusals by reason (non-zero reasons only, so the line stays short). */
export interface DiscardSummary {
    records: number;
    dropped: number;
    reasons: Partial<Record<DiscardReason, number>>;
}

/** The out-parameter `mapOccurrences` counts into. Passed in rather than returned, matching `transit/discards.ts`'s `DiscardTally` -- see its header for why. */
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
