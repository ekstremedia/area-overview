/**
 * How many records a road mapper refused, and why.
 *
 * The mappers in this directory are pure and have no logger, and they
 * are deliberately forgiving: a record whose attributes do not parse, or
 * whose mapped result fails the shared contract, costs that record
 * rather than the whole viewport. That is the right behaviour and it is
 * also the dangerous one, because an upstream attribute rename empties
 * the layer while the masthead reads "0 vegmeldinger" -- which is
 * exactly what a genuinely quiet evening looks like. It is not
 * hypothetical: three attribute names were wrong in this feature's own
 * plan, and `docs/ARCHITECTURE.md` carries a gotcha entry about the
 * class of bug.
 *
 * So a mapper counts what it threw away, and the route logs the tally
 * once per response when it is non-zero -- the same shape as the
 * 500-record cap warning in `routes/road-situations.ts`, and with the
 * same promise: a tally carries counts and reason names, never a bbox
 * and never a coordinate.
 *
 * **Only unexpected drops are counted.** A situation that has expired, a
 * camera upstream flags as faulted, a weather station with no camera in
 * this viewport -- those are the filters working, they happen on every
 * healthy response, and counting them would make the warning fire
 * constantly and teach its reader to skip it. `total` still counts every
 * record the mapper looked at, so the log reads "2 of 54" and means it.
 */

/**
 * Why a record was refused. A closed vocabulary, because these strings
 * end up in the container log and are what someone greps for.
 *
 *  - `attributes` -- upstream's raw attribute bag did not parse. The
 *    rename case: if this is most of `total`, a field was renamed.
 *  - `unplaceable` -- nothing to put on the map: no display coordinates
 *    and no usable geometry.
 *  - `contract`  -- the mapped record failed the shared schema on the
 *    way out. A bug on this side of the wire, or a value (a nonsense
 *    coordinate, an unparseable timestamp) upstream should not have
 *    sent.
 *  - `imageHost` -- a road camera's still image was not on Vegvesen's
 *    own host. A security control, not a data quirk: the visitor's
 *    browser fetches that URL directly (see `road-cameras.ts`), so a
 *    move off `kamera.atlas.vegvesen.no` deletes every camera, and it
 *    must never do so quietly.
 */
export type DiscardReason = 'attributes' | 'unplaceable' | 'contract' | 'imageHost';

/** A tally flattened for a log line: how many records were seen, how many were refused, and the refusals by reason (non-zero reasons only, so the line stays short). */
export interface DiscardSummary {
    records: number;
    dropped: number;
    reasons: Partial<Record<DiscardReason, number>>;
}

/**
 * The out-parameter a mapper counts into.
 *
 * Passed in rather than returned so that the mappers keep their plain
 * array/record return types and every existing caller is unaffected; a
 * caller that wants the numbers constructs one and reads it afterwards.
 *
 * `records` counts *records*, the unit upstream sends. A road situation
 * is several of them grouped, so a situation refused after grouping
 * counts as one discard against the records it was built from -- which
 * is why `dropped` is a count of refusals, never a subset of `records`
 * to be subtracted from it.
 */
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
