/**
 * The one place this app talks to NVE Varsom's per-region avalanche
 * warning endpoint (`GET /AvalancheWarningByRegion/Detail/{regionId}/{lang}
 * /{from}/{to}`), for the warnings layer's avalanche half. Keyless, langKey
 * `1` is Norwegian; passing the same date for both `from` and `to` narrows
 * the answer to "today" (confirmed live 2026-09-16).
 *
 * **`DangerLevel` is a string, never a number, and `"0"` does not mean
 * level zero.** Out of season NVE answers `DangerLevel: "0"`,
 * `DangerLevelName` empty and `MainText: "Ikke vurdert"` ("not assessed")
 * rather than omitting the region -- and `AvalancheWarningSchema`'s own
 * header is explicit that this must become an absent entry, not a
 * zero-level one. `mapAvalancheWarning` treats either signal (`"0"` OR
 * `"Ikke vurdert"`) as "not assessed", since a real response was observed
 * to set both together but nothing guarantees a future one always will.
 *
 * The region roster (id, name, outline) and the bbox-intersection centroid
 * this module needs to build an `AvalancheWarning` both come from
 * `regions.ts` -- this file only knows how to fetch and interpret one
 * region's *warning*, never its geometry.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';
import { AvalancheWarningSchema, type AvalancheWarning } from '../../shared/schemas/warnings.js';
import type { OutboundGate } from '../outbound-gate.js';
import type { LatLng } from '../../shared/schemas/common.js';
import type { NveRegion } from './regions.js';

const NVE_AVALANCHE_BASE_URL = 'https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/';

/** Norwegian -- the only language this app reads NVE's text in (`MainText`, `DangerLevelName`, neither of which reaches the client -- see this file's header on why `MainText` is only ever compared against, never shown). */
const NORWEGIAN_LANG_KEY = 1;

/** Reported when the shared NVE gate is shut. Same gate, and same message convention, as `regions.ts`. */
const GATE_CLOSED_MESSAGE = 'NVE AvalancheWarningByRegion request skipped: outbound rate gate is closed';

/** Out of season, NVE answers with these rather than omitting the region -- see this file's header. */
const NOT_ASSESSED_DANGER_LEVEL = '0';
const NOT_ASSESSED_MAIN_TEXT = 'ikke vurdert';

/**
 * Whether `mainText` is NVE's "not assessed" marker. Compared trimmed and
 * case-insensitively, and by prefix rather than exact equality: this file's
 * own header says `DangerLevel` alone must not be trusted, which only holds
 * if this second signal is actually robust to a trailing space, a case
 * variant, or upstream appending punctuation (`"Ikke vurdert."`) -- none of
 * which should make a real "not assessed" answer slip through as assessed.
 */
function isNotAssessedMainText(mainText: string | null | undefined): boolean {
    if (mainText === null || mainText === undefined) return false;
    return mainText.trim().toLowerCase().startsWith(NOT_ASSESSED_MAIN_TEXT);
}

/**
 * Norway's UTC offset for a given local calendar date, EU DST rules
 * (CEST, UTC+2, from the last Sunday of March to the last Sunday of
 * October; CET, UTC+1, otherwise). Good enough to disambiguate NVE's
 * offset-less local timestamps (see `normalizeValidAt` below) without
 * pulling in a timezone library this project does not otherwise depend on
 * (`package.json` has no `date-fns`/`luxon`/equivalent) -- the exact
 * instant of the spring/autumn transition (typically 01:00 UTC) is not
 * worth chasing for a field (`validAt`) that is never used for anything
 * more precise than "which day is this warning for".
 */
function osloUtcOffset(year: number, month: number, day: number): string {
    function lastSundayOfMonthUtc(y: number, monthIndex: number): number {
        const lastDay = new Date(Date.UTC(y, monthIndex + 1, 0)).getUTCDate();
        const last = new Date(Date.UTC(y, monthIndex, lastDay));
        return lastDay - last.getUTCDay();
    }

    const dstStartDay = lastSundayOfMonthUtc(year, 2); // March
    const dstEndDay = lastSundayOfMonthUtc(year, 9); // October
    const asNumber = month * 100 + day;
    const isDst = asNumber > 3 * 100 + dstStartDay && asNumber < 10 * 100 + dstEndDay;
    return isDst ? '+02:00' : '+01:00';
}

/** Matches an ISO-8601 timestamp that already carries an explicit offset (`Z` or `+HH:MM`/`-HH:MM`). */
const HAS_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Normalizes one of NVE's timestamps (`ValidFrom`) to carry an explicit UTC
 * offset. NVE ships Norwegian local time with no offset suffix at all
 * (e.g. `"2026-01-15T00:00:00"`), unlike every other layer's timestamps --
 * left as-is, a browser's `Date` parses that as *its own* local time, not
 * Norway's, silently shifting the value. Returns the input unchanged if it
 * already carries an offset (defensive; never observed live) or does not
 * match the expected shape at all (left for `IsoTimestampSchema` to reject).
 */
export function normalizeValidAt(value: string): string {
    if (HAS_OFFSET_PATTERN.test(value)) return value;

    const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
    if (!match) return value;

    const [, yearStr, monthStr, dayStr] = match;
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    return `${value}${osloUtcOffset(year, month, day)}`;
}

export function avalancheWarningUrl(regionId: string, dateStr: string): string {
    return `${NVE_AVALANCHE_BASE_URL}AvalancheWarningByRegion/Detail/${encodeURIComponent(regionId)}/${String(NORWEGIAN_LANG_KEY)}/${dateStr}/${dateStr}`;
}

const RawWarningEntrySchema = z.object({
    RegionId: z.union([z.number(), z.string()]).nullish(),
    RegionName: z.string().nullish(),
    DangerLevel: z.string().nullish(),
    MainText: z.string().nullish(),
    ValidFrom: z.string().nullish(),
});
export type RawWarningEntry = z.infer<typeof RawWarningEntrySchema>;

export interface FetchRegionWarningOptions {
    upstreamTimeoutMs: number;
    /** The process-wide NVE outbound budget, shared with `regions.ts`'s roster fetch (`outbound-gate.ts`). */
    gate?: OutboundGate | undefined;
    fetchImpl?: typeof fetch;
}

/**
 * Fetches today's warning entries for one region. NVE's date-range
 * endpoint answers with one entry per day in `[from, to]`; passing
 * `dateStr` (`YYYY-MM-DD`) for both narrows that to a single, possibly
 * empty, array. Mapping onto `AvalancheWarning` (including the
 * "not assessed" absence rule) is `mapAvalancheWarning`'s job.
 */
export async function fetchRegionWarning(regionId: string, dateStr: string, options: FetchRegionWarningOptions): Promise<Result<RawWarningEntry[]>> {
    const fetchImpl = options.fetchImpl ?? fetch;

    if (options.gate && !options.gate.tryTake()) {
        return err({ message: GATE_CLOSED_MESSAGE });
    }

    let response: Response;
    try {
        response = await fetchImpl(avalancheWarningUrl(regionId, dateStr), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(options.upstreamTimeoutMs),
        });
    } catch {
        return err({ message: `NVE AvalancheWarningByRegion request for region "${regionId}" failed (network error)` });
    }
    if (!response.ok) {
        return err({ message: `NVE AvalancheWarningByRegion for region "${regionId}" responded with status ${String(response.status)}` });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return err({ message: `NVE AvalancheWarningByRegion for region "${regionId}" returned a non-JSON body` });
    }

    const parsed = z.array(RawWarningEntrySchema).safeParse(body);
    if (!parsed.success) {
        return err({ message: `NVE AvalancheWarningByRegion for region "${regionId}" response failed schema validation`, cause: parsed.error });
    }

    return ok(parsed.data);
}

/**
 * Maps one region's raw warning entries (today's date range: at most one)
 * onto an `AvalancheWarning`, or `null` when there is nothing to show:
 * no entry at all, or an entry that reports "not assessed" (see this
 * file's header) or a `DangerLevel` outside NVE's own 1-5 scale.
 */
export function mapAvalancheWarning(
    entries: readonly RawWarningEntry[],
    region: Pick<NveRegion, 'regionId' | 'regionName' | 'outline'>,
    point: LatLng,
): AvalancheWarning | null {
    const entry = entries[0];
    if (!entry) return null;
    if (entry.DangerLevel === undefined || entry.DangerLevel === null || entry.DangerLevel === NOT_ASSESSED_DANGER_LEVEL) return null;
    if (isNotAssessedMainText(entry.MainText)) return null;

    const dangerLevel = Number(entry.DangerLevel);
    if (!Number.isInteger(dangerLevel) || dangerLevel < 1 || dangerLevel > 5) return null;

    const candidate = {
        regionId: region.regionId,
        regionName: entry.RegionName ?? region.regionName,
        dangerLevel,
        validAt: normalizeValidAt(entry.ValidFrom ?? ''),
        outline: region.outline,
        point,
    };

    const validated = AvalancheWarningSchema.safeParse(candidate);
    return validated.success ? validated.data : null;
}
