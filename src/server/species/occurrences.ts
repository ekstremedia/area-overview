/**
 * Turns GBIF's raw occurrence records into this app's grouped species
 * sightings. Pure: no network, no clock of its own beyond what it is
 * handed via `gbif.ts`'s already-fetched records and `total`. Same split
 * `entur.ts`/`vehicles.ts` use for transit: `gbif.ts` hands back untyped
 * bags, and this is the only place that decides what a malformed one
 * costs.
 *
 * ## The hard privacy requirement
 *
 * GBIF's raw records carry `recordedBy` -- the private individual who
 * reported a sighting, frequently at their own home coordinate (confirmed
 * live, 2026-09-17: a real, non-fictional name on a residential-garden
 * bird record -- see `gbif.ts`'s header). **This field must never reach
 * the serialised response, in any form, anywhere.**
 *
 * The load-bearing control is `RawOccurrenceSchema` below: it is a closed
 * allow-list (`z.object({...})` with no `.passthrough()`), not a
 * passthrough of the raw record, and it simply does not name
 * `recordedBy` as one of its fields. Zod strips unrecognised keys from a
 * plain object schema by default, so `recordedBy` cannot survive
 * `.safeParse` even if every line below this comment were rewritten
 * carelessly. The second control is discipline in this file: every
 * `Sighting` field is built by reading a named property off the *parsed*
 * result (`raw.scientificName`, `raw.kingdom`, ...), never by spreading
 * either the original untyped record or the parsed one
 * (`{...record}`/`{...raw}`) -- a spread of the raw record would defeat
 * the allow-list entirely, and is why one never appears here.
 *
 * ## Design decisions this file makes, undocumented anywhere upstream
 *
 *  - **Grouping key**: `speciesKey` plus position rounded to three
 *    decimals (~110m) -- `` `${speciesKey}:${lat},${lng}` ``. A record
 *    missing `speciesKey` cannot be grouped meaningfully and is discarded
 *    (`missingSpeciesKey`); see `discards.ts`.
 *  - **Per-group scalar fields** (`scientificName`, `vernacularName`,
 *    `kingdom`, `class`, `point`) take the *newest* record's own value,
 *    matching `observedAt`'s own "newest wins" rule and the doc comment
 *    on `SightingSchema.id`: a group persists across dates and carries the
 *    newest record's identity, not an arbitrary or oldest one.
 *  - **`class`, when absent from a record**, falls back to that record's
 *    own `kingdom`, and to the literal string `'unknown'` if `kingdom` is
 *    itself absent too -- `SightingSchema.class` is non-nullable, so some
 *    fallback is required, and kingdom is the closest thing to a taxonomic
 *    answer this app already has on hand for that record.
 *  - **`coordinateUncertaintyMeters`** takes the newest record in the
 *    group that actually reported one (searching newest-to-oldest), not
 *    simply the newest record's own value -- so one record's silence on
 *    uncertainty does not hide a real figure a slightly older record in
 *    the same group provided.
 *  - **`individualCount`** sums every record in the group that reported a
 *    positive integer count; a record that did not report one, or
 *    reported a non-positive or non-integer value (GBIF's
 *    `occurrenceStatus: ABSENT` records can carry `individualCount: 0`,
 *    even though this app already filters `occurrenceStatus=PRESENT` at
 *    the query -- see `gbif.ts` -- a stray `0`/negative/fractional value
 *    is treated the same way defensively), contributes nothing to the sum
 *    (neither zero nor a discard). `SightingSchema.individualCount` is
 *    `.int().positive()`, so summing a `0` in verbatim would make the
 *    *group* fail that schema and be discarded entirely as `contract` --
 *    silently vanishing a real sighting over one record's unusable count.
 *    The group's own `individualCount` is `null` only when *no* record in
 *    the group reported a usable count at all.
 *  - **Licence conflict**: GBIF's real records were confirmed live to
 *    disagree within the same viewport (`CC BY 4.0` and `CC BY-NC 4.0`
 *    legalcode URLs, both observed against Norwegian data on 2026-09-17).
 *    Since `SightingSchema.license` is one string per group, this file
 *    picks the *most restrictive* licence among the group's distinct
 *    values, ranked `CC0` < `CC BY` < `CC BY-NC`/`CC BY-SA` < `CC
 *    BY-NC-ND` < anything unrecognised (treated as the most restrictive of
 *    all, deliberately: understating a stranger's reuse rights costs
 *    nothing; overstating them, so a viewer commercially reuses a photo
 *    or record some field survey never licensed for that, would not).
 *    Ties keep the first-encountered value.
 *  - **Dataset titles**: GBIF's occurrence search response carries only
 *    `datasetKey`, never a human-readable title, on each record (confirmed
 *    live). `mapOccurrences` itself stays pure and network-free -- it
 *    still reports `{key, title: key}` for every dataset. Resolving the
 *    real title is a separate, deliberately optional step:
 *    `enrichDatasetTitles` (below) takes an injected async `lookup` and
 *    patches `title` in place afterwards. `species/dataset-titles.ts` is
 *    the real implementation of that lookup (`GET /v1/dataset/{key}`,
 *    cached for 30 days, fully fail-safe) -- see its header. Splitting it
 *    out this way means `mapOccurrences`'s own grouping/licence/cap tests
 *    stay synchronous and need no network mocking at all.
 *  - **Sort/cap**: groups are sorted newest-`observedAt`-first, then
 *    capped at `SIGHTINGS_CAP`, so a truncated response still shows the
 *    most recent sightings rather than an arbitrary slice. `truncated` is
 *    `true` for either of two distinct reasons, both real, collapsed into
 *    one flag: GBIF's own reported `total` (the envelope's `count`, not a
 *    group's `count`) exceeds the number of raw records `gbif.ts` actually
 *    fetched (some matching records were never seen at all, whether
 *    because of GBIF's own per-page `GBIF_PAGE_LIMIT` or `gbif.ts`'s own
 *    `GBIF_MAX_RAW_RECORDS` paging cap -- see its header); or the grouped
 *    result itself exceeds `SIGHTINGS_CAP` before slicing. A caller cannot
 *    currently tell the two apart from `truncated` alone, which is fine
 *    for the one thing this flag drives today (a "showing partial results"
 *    hint in the UI) -- see this file's plan for whether that ever needs
 *    to change.
 */
import { z } from 'zod';
import { SightingSchema, type Sighting } from '../../shared/schemas/species.js';
import { DiscardTally } from './discards.js';
import type { RawOccurrenceRecord } from './gbif.js';

/** The most groups one response ever carries -- see this file's header. */
export const SIGHTINGS_CAP = 400;

/** The grid a raw record's own coordinate is rounded to for grouping -- ~110m, per this file's header. */
const GROUP_POSITION_DECIMALS = 3;

/**
 * The fields this app reads off one raw occurrence record, and nothing
 * else. Deliberately NOT `recordedBy` -- see this file's header. A plain
 * `z.object` (no `.passthrough()`), so any field not named here,
 * including `recordedBy`, is stripped by `.safeParse` regardless of what
 * upstream actually sent.
 */
const RawOccurrenceSchema = z.object({
    speciesKey: z.number().nullish(),
    scientificName: z.string().nullish(),
    acceptedScientificName: z.string().nullish(),
    vernacularName: z.string().nullish(),
    kingdom: z.string().nullish(),
    class: z.string().nullish(),
    eventDate: z.string().nullish(),
    decimalLatitude: z.number().nullish(),
    decimalLongitude: z.number().nullish(),
    coordinateUncertaintyInMeters: z.number().nullish(),
    individualCount: z.number().nullish(),
    license: z.string().nullish(),
    datasetKey: z.string().nullish(),
});

/** One record's fields, after the allow-list parse and this file's own fallbacks -- everything a group is built from. */
interface NormalizedRecord {
    speciesKey: number;
    scientificName: string;
    vernacularName: string | null;
    kingdom: string;
    taxonClass: string;
    eventDateMs: number;
    observedAt: string;
    point: { lat: number; lng: number };
    coordinateUncertaintyMeters: number | null;
    individualCount: number | null;
    license: string;
    datasetKey: string;
}

const UNKNOWN_LICENSE = 'unknown';
const UNKNOWN_DATASET_KEY = 'unknown';

/**
 * Ranks a licence string by how restrictive it is, higher meaning more
 * restrictive. Matches on the Creative Commons legalcode URL's own path
 * segments -- GBIF's real shape, see `gbif.ts`'s header, not a short
 * `"CC BY 4.0"`-style label. Anything unrecognised ranks as the *most*
 * restrictive of all -- see this file's header for why that is the safe
 * default.
 */
export function licenseRank(license: string): number {
    const value = license.toLowerCase();
    if (value.includes('publicdomain/zero') || value.includes('cc0')) return 0; // CC0
    if (/\/licenses\/by\/\d/.test(value)) return 1; // CC BY
    if (value.includes('/by-nc-nd/')) return 3; // CC BY-NC-ND
    if (value.includes('/by-nc/') || value.includes('/by-sa/') || value.includes('/by-nc-sa/')) return 2; // CC BY-NC / CC BY-SA / CC BY-NC-SA
    return 4; // Unrecognised -- treated as the most restrictive, deliberately.
}

/** The most restrictive of `licenses`' distinct values (see this file's header); ties keep the first-encountered value. Never called with an empty array -- the no-initial-value `reduce` below relies on that, the same way this file relies on a group never being empty. */
export function mostRestrictiveLicense(licenses: readonly string[]): string {
    return licenses.reduce((chosen, candidate) => (licenseRank(candidate) > licenseRank(chosen) ? candidate : chosen));
}

/** Rounds a coordinate to the grouping grid -- see `GROUP_POSITION_DECIMALS`. */
function roundForGrouping(value: number): number {
    const factor = 10 ** GROUP_POSITION_DECIMALS;
    return Math.round(value * factor) / factor;
}

/**
 * Parses and normalises one raw record, or reports why it was refused.
 * Does not decide grouping -- only whether this record can be used at
 * all.
 */
function normalizeRecord(record: RawOccurrenceRecord, discards: DiscardTally): NormalizedRecord | null {
    const parsed = RawOccurrenceSchema.safeParse(record ?? {});
    if (!parsed.success) {
        discards.discard('attributes');
        return null;
    }
    const raw = parsed.data;

    if (raw.speciesKey === null || raw.speciesKey === undefined) {
        discards.discard('missingSpeciesKey');
        return null;
    }

    if (!raw.eventDate) {
        discards.discard('missingEventDate');
        return null;
    }
    const eventDateMs = Date.parse(raw.eventDate);
    if (Number.isNaN(eventDateMs)) {
        discards.discard('missingEventDate');
        return null;
    }

    if (raw.decimalLatitude === null || raw.decimalLatitude === undefined || raw.decimalLongitude === null || raw.decimalLongitude === undefined) {
        discards.discard('attributes');
        return null;
    }

    const scientificName = raw.scientificName ?? raw.acceptedScientificName;
    if (!scientificName) {
        discards.discard('attributes');
        return null;
    }

    return {
        speciesKey: raw.speciesKey,
        scientificName,
        vernacularName: raw.vernacularName ?? null,
        kingdom: raw.kingdom ?? 'unknown',
        taxonClass: raw.class ?? raw.kingdom ?? 'unknown',
        eventDateMs,
        observedAt: raw.eventDate,
        point: { lat: raw.decimalLatitude, lng: raw.decimalLongitude },
        coordinateUncertaintyMeters: raw.coordinateUncertaintyInMeters ?? null,
        individualCount: raw.individualCount ?? null,
        license: raw.license ?? UNKNOWN_LICENSE,
        datasetKey: raw.datasetKey ?? UNKNOWN_DATASET_KEY,
    };
}

export interface MapOccurrencesResult {
    sightings: Sighting[];
    /** See this file's header for the exact rule. */
    truncated: boolean;
}

/**
 * Maps `records` (one GBIF page, see `gbif.ts`) onto grouped
 * `Sighting[]`, applying the grouping, per-group aggregation, licence
 * conflict, sort, and cap/truncation rules documented in this file's
 * header. `gbifTotal` is GBIF's own reported match count for the query
 * (the envelope's `count`), used only to decide `truncated` honestly.
 */
export function mapOccurrences(
    records: readonly RawOccurrenceRecord[],
    gbifTotal: number,
    discards: DiscardTally = new DiscardTally(),
): MapOccurrencesResult {
    const groups = new Map<string, NormalizedRecord[]>();

    for (const record of records) {
        discards.seen();
        const normalized = normalizeRecord(record, discards);
        if (!normalized) continue;

        const lat = roundForGrouping(normalized.point.lat);
        const lng = roundForGrouping(normalized.point.lng);
        const groupId = `${String(normalized.speciesKey)}:${lat.toFixed(GROUP_POSITION_DECIMALS)},${lng.toFixed(GROUP_POSITION_DECIMALS)}`;

        const existing = groups.get(groupId);
        if (existing) {
            existing.push(normalized);
        } else {
            groups.set(groupId, [normalized]);
        }
    }

    const sightings: Sighting[] = [];
    for (const [groupId, groupRecords] of groups) {
        // Newest first, within this group -- every "newest wins" rule
        // below reads from index 0. `groupRecords` is never empty (a group
        // is only ever created alongside its first record, above), so
        // `newest` is always defined -- checked rather than asserted, to
        // satisfy this codebase's lint rules on non-null assertions.
        const sorted = [...groupRecords].sort((a, b) => b.eventDateMs - a.eventDateMs);
        const newest = sorted[0];
        if (!newest) continue;

        // A non-positive or non-integer individualCount (GBIF's
        // occurrenceStatus: ABSENT records can carry `0`) is treated as
        // "not reported", exactly like a record with no individualCount
        // at all -- see this file's header on `individualCount`. Summing
        // it in verbatim would make `SightingSchema.individualCount`
        // (`.int().positive()`) reject the whole group.
        const individualCounts = sorted
            .map((r) => r.individualCount)
            .filter((value): value is number => value !== null && Number.isInteger(value) && value > 0);
        const individualCount = individualCounts.length > 0 ? individualCounts.reduce((sum, value) => sum + value, 0) : null;

        const coordinateUncertaintyMeters = sorted.find((r) => r.coordinateUncertaintyMeters !== null)?.coordinateUncertaintyMeters ?? null;

        const distinctLicenses = [...new Set(sorted.map((r) => r.license))];
        const license = mostRestrictiveLicense(distinctLicenses);

        const datasets = [...new Set(sorted.map((r) => r.datasetKey))].map((key) => ({ key, title: key }));

        const candidate = {
            id: groupId,
            scientificName: newest.scientificName,
            vernacularName: newest.vernacularName,
            kingdom: newest.kingdom,
            class: newest.taxonClass,
            datasets,
            license,
            coordinateUncertaintyMeters,
            count: sorted.length,
            individualCount,
            point: newest.point,
            observedAt: newest.observedAt,
        };

        const validated = SightingSchema.safeParse(candidate);
        if (validated.success) {
            sightings.push(validated.data);
        } else {
            discards.discard('contract');
        }
    }

    // Newest sighting first, so a truncated response still shows the most
    // recent activity -- see this file's header.
    sightings.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));

    const groupedBeforeCap = sightings.length;
    const truncated = gbifTotal > records.length || groupedBeforeCap > SIGHTINGS_CAP;

    return { sightings: sightings.slice(0, SIGHTINGS_CAP), truncated };
}

export interface EnrichDatasetTitlesOptions {
    /** Resolves one dataset key to its title. Must never throw or reject -- `species/dataset-titles.ts`'s `lookupDatasetTitle` is documented to always resolve, falling back to the key itself on any failure or timeout, so this function has nothing of its own to catch. */
    lookup: (key: string) => Promise<string>;
}

/**
 * Resolves every distinct dataset key across `sightings` to its
 * human-readable title via `options.lookup`, one lookup per distinct key
 * (not per sighting, not per group -- the same dataset can appear in many
 * groups), run in parallel. See this file's header on why this is a
 * separate step from `mapOccurrences` rather than folded into it.
 */
export async function enrichDatasetTitles(sightings: readonly Sighting[], options: EnrichDatasetTitlesOptions): Promise<Sighting[]> {
    const keys = new Set<string>();
    for (const sighting of sightings) {
        for (const dataset of sighting.datasets) keys.add(dataset.key);
    }
    if (keys.size === 0) return [...sightings];

    const titles = new Map<string, string>();
    await Promise.all(
        [...keys].map(async (key) => {
            titles.set(key, await options.lookup(key));
        }),
    );

    return sightings.map((sighting) => ({
        ...sighting,
        datasets: sighting.datasets.map((dataset) => ({ key: dataset.key, title: titles.get(dataset.key) ?? dataset.key })),
    }));
}
