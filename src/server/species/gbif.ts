/**
 * The one place this app talks to GBIF's occurrence search
 * (`api.gbif.org/v1/occurrence/search`), for the species layer's
 * sightings. Keyless: there is no token dance here at all, only a query,
 * a timeout and a tolerant parse. Same shape as `transit/entur.ts`/
 * `warnings/met-alerts.ts`: an injected `fetchImpl`, a shared outbound
 * gate checked before anything is sent, and raw records handed back
 * untyped so `species/occurrences.ts` is the only place that decides what
 * a malformed one costs.
 *
 * Ground truth, probed live on 2026-09-17 and pinned by tests rather than
 * left to memory:
 *
 *  - **`geometry` is a WKT `POLYGON`, longitude first** -- the mirror
 *    image of this app's own `[lat,lng]` convention used everywhere else,
 *    and the ring must be explicitly closed by repeating the first point.
 *    Getting the axis order backwards does not error; it is a spatial
 *    query against a real, differently-shaped rectangle, so it fails
 *    exactly the way a reversed Vegvesen bbox does (`vegvesen-wfs.ts`'s
 *    own header) -- silently, and plausibly.
 *  - **`limit` is capped server-side at 300** regardless of what is
 *    requested (confirmed by requesting 1000 and receiving 300), so one
 *    page is the practical ceiling for a single fetch -- see this file's
 *    header on how `occurrences.ts` reports honestly when the true match
 *    count (`count` in the envelope) exceeds what one page returns.
 *  - **`license` is a full Creative Commons legalcode URL**
 *    (`http://creativecommons.org/licenses/by-nc/4.0/legalcode`), not the
 *    short `"CC BY-NC 4.0"`-style label an earlier version of this file's
 *    plan assumed. `occurrences.ts`'s licence-conflict ranking matches on
 *    the URL's own path segments for this reason.
 *  - **`recordedBy` is present on real records and does carry a private
 *    individual's name** (confirmed live: a real, non-fictional name was
 *    returned for a residential-garden sighting). This module hands back
 *    every record as an untyped bag -- deliberately, to match every other
 *    fetcher in this codebase -- but `occurrences.ts` never reads this
 *    field, and its own record schema is a closed allow-list rather than
 *    a passthrough, so `recordedBy` cannot survive that parse even if a
 *    future change there stopped being careful about which fields it
 *    spreads. See `occurrences.ts`'s header for the full argument.
 *  - **There is no server-side "sort by most recent" for occurrence
 *    search** -- results come back in whatever order GBIF's index happens
 *    to hold them (ingestion order in practice), so a single page is an
 *    ingestion-ordered sample of the whole match set, not a "most recent
 *    N" sample. Measured live 2026-09-17: `days=365` on the Vesterålen
 *    bbox matched 11 041 records total, but the first (and, before this
 *    fix, only) page of 300 clustered entirely in 2026-01-01..01-25 --
 *    nowhere near "recent". Sorting that one arbitrary page newest-first
 *    (`occurrences.ts` still does, for a stable within-page order) cannot
 *    fix this; only fetching more of the match set can. `fetchGbifOccurrences`
 *    now pages via `offset` up to `GBIF_MAX_RAW_RECORDS`, so "recent
 *    sightings" is recent within what was actually fetched, not just
 *    within one arbitrary page of it. It is still not a guarantee of the
 *    single true newest record when `total` exceeds the cap -- see this
 *    file's `GBIF_MAX_RAW_RECORDS` doc comment and `occurrences.ts`'s
 *    header on `truncated`.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';
import type { Bbox } from '../layers/bbox.js';
import type { OutboundGate } from '../outbound-gate.js';

export const GBIF_OCCURRENCE_SEARCH_URL = 'https://api.gbif.org/v1/occurrence/search';

/** GBIF's own server-side ceiling on `limit` -- see this file's header. Requesting more just gets silently capped back to this. */
export const GBIF_PAGE_LIMIT = 300;

/**
 * The most raw records one `fetchGbifOccurrences` call will page through
 * (4 pages of `GBIF_PAGE_LIMIT`) before giving up on covering the rest of
 * `total` -- chosen to keep outbound call count and latency bounded for a
 * single viewport request while covering enough of a busy bbox's match
 * set that "recent" is a real property of what gets grouped and sorted,
 * not just of one arbitrary page. See this file's header for why paging
 * exists at all. When `total` exceeds this cap, `occurrences.ts` reports
 * `truncated: true` for that reason (as well as for its own 400-group
 * cap) -- see its header.
 */
export const GBIF_MAX_RAW_RECORDS = 1200;

/** Reported when the GBIF gate is shut, so a route can tell this apart from an upstream that actually failed. */
const GATE_CLOSED_MESSAGE = 'GBIF occurrence search request skipped: outbound rate gate is closed';

/**
 * A WKT `POLYGON` for `bbox`, longitude first and explicitly closed (the
 * first point repeated as the last) -- GBIF's own required shape, the
 * mirror image of this app's `[lat,lng]` convention everywhere else. See
 * this file's header.
 */
export function bboxToWkt(bbox: Bbox): string {
    const corners: [number, number][] = [
        [bbox.minLng, bbox.minLat],
        [bbox.maxLng, bbox.minLat],
        [bbox.maxLng, bbox.maxLat],
        [bbox.minLng, bbox.maxLat],
        [bbox.minLng, bbox.minLat], // closes the ring
    ];
    return `POLYGON((${corners.map(([lng, lat]) => `${String(lng)} ${String(lat)}`).join(',')}))`;
}

/** `YYYY-MM-DD`, in UTC -- GBIF's own `eventDate` range format. */
function dateStr(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** The `from,to` range GBIF's `eventDate` parameter takes: today minus `days`, through today, both in UTC. */
export function eventDateRange(days: number, now: Date): string {
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return `${dateStr(from)},${dateStr(now)}`;
}

/**
 * One occurrence record, kept as an untyped bag -- deliberately, the same
 * split `entur.ts`/`vegvesen-wfs.ts` use: `occurrences.ts` is the only
 * place that validates the fields it actually reads (through its own
 * closed allow-list schema, never a passthrough) and counts what does not
 * parse, so an upstream field this app does not use -- including
 * `recordedBy`, see this file's header -- can change shape, or simply
 * exist, without costing the response or leaking through it.
 */
const RawOccurrenceRecordSchema = z.record(z.string(), z.unknown()).nullable().catch(null);

export type RawOccurrenceRecord = z.infer<typeof RawOccurrenceRecordSchema>;

/** The search envelope: `count` is GBIF's own total match count for the query, independent of how many `results` this one page actually carried -- see this file's header on the 300-record page cap. */
const GbifSearchResponseSchema = z.object({
    count: z.number().nonnegative().catch(0),
    results: z.array(RawOccurrenceRecordSchema).nullish(),
});

export interface FetchGbifOccurrencesOptions {
    /** Bounded deadline for EACH page request -- `config.upstreamTimeoutMs` in production. A slow later page cannot exceed this either; it can only shorten how many pages are fetched. */
    upstreamTimeoutMs: number;
    /** Identifies this app to GBIF, the same politeness convention this codebase already follows for MET (`config.metUserAgent`) and Entur (`ET-Client-Name`); GBIF publishes no equivalent requirement but there is no reason to be anonymous where MET and Entur are not. Reuses `config.metUserAgent`'s value verbatim -- it names the app and a contact, nothing MET-specific. */
    userAgent: string;
    /** The process-wide GBIF outbound budget (`outbound-gate.ts`). Checked once per `fetchGbifOccurrences` call, not once per page -- the budget bounds how often a *viewport* is queried (attacker-controlled via pan/zoom), and paging is an internal detail of answering one such query, not a new one. A refusal is reported as an ordinary `Result` error so the route takes the same stale-then-502 path an upstream outage already takes. */
    gate?: OutboundGate | undefined;
    fetchImpl?: typeof fetch;
}

export interface GbifOccurrenceSearchResult {
    /** Every record fetched across all pages, exactly as GBIF sent them -- may be fewer than `total` when `total` exceeds `GBIF_MAX_RAW_RECORDS`. */
    records: RawOccurrenceRecord[];
    /** GBIF's own total match count for the query -- may exceed `records.length` when more matched than paging actually fetched (`GBIF_MAX_RAW_RECORDS`). `occurrences.ts` uses this to report `truncated` honestly. */
    total: number;
}

function buildSearchUrl(bbox: Bbox, days: number, now: Date, offset: number): URL {
    const url = new URL(GBIF_OCCURRENCE_SEARCH_URL);
    url.searchParams.set('geometry', bboxToWkt(bbox));
    url.searchParams.set('hasCoordinate', 'true');
    url.searchParams.set('hasGeospatialIssue', 'false');
    // Excludes "this species was NOT seen here" absence records -- GBIF
    // allows searching those in deliberately (some surveys report a
    // negative result), but a `Sighting` pin means a positive one.
    url.searchParams.set('occurrenceStatus', 'PRESENT');
    url.searchParams.set('eventDate', eventDateRange(days, now));
    url.searchParams.set('limit', String(GBIF_PAGE_LIMIT));
    url.searchParams.set('offset', String(offset));
    return url;
}

/**
 * Fetches raw occurrence records inside `bbox` and within `days` of `now`,
 * paging via `offset` up to `GBIF_MAX_RAW_RECORDS` records or until
 * `total` is fully covered, whichever comes first -- see this file's
 * header on why one page is not enough to honestly call the result
 * "recent". Mapping onto `Sighting[]` -- including the grouping,
 * licence-conflict and cap/truncation logic -- is `species/occurrences.ts`'s
 * job.
 */
export async function fetchGbifOccurrences(
    bbox: Bbox,
    days: number,
    now: Date,
    options: FetchGbifOccurrencesOptions,
): Promise<Result<GbifOccurrenceSearchResult>> {
    const fetchImpl = options.fetchImpl ?? fetch;

    // Checked before the first request is built: a refusal must cost nothing.
    if (options.gate && !options.gate.tryTake()) {
        return err({ message: GATE_CLOSED_MESSAGE });
    }

    const records: RawOccurrenceRecord[] = [];
    let total = 0;
    let offset = 0;

    for (let page = 0; ; page += 1) {
        const url = buildSearchUrl(bbox, days, now, offset);

        let response: Response;
        try {
            response = await fetchImpl(url, {
                headers: { Accept: 'application/json', 'User-Agent': options.userAgent },
                signal: AbortSignal.timeout(options.upstreamTimeoutMs),
            });
        } catch {
            if (page === 0) return err({ message: 'GBIF occurrence search request failed (network error)' });
            break; // A later page failing degrades to what was already fetched, rather than discarding it.
        }
        if (!response.ok) {
            if (page === 0) return err({ message: `GBIF occurrence search endpoint responded with status ${String(response.status)}` });
            break;
        }

        let body: unknown;
        try {
            body = await response.json();
        } catch {
            if (page === 0) return err({ message: 'GBIF occurrence search endpoint returned a non-JSON body' });
            break;
        }

        const parsed = GbifSearchResponseSchema.safeParse(body);
        if (!parsed.success) {
            if (page === 0) {
                return err({
                    message: 'GBIF occurrence search response failed schema validation',
                    cause: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path })),
                });
            }
            break;
        }

        total = parsed.data.count;
        const pageResults = parsed.data.results ?? [];
        records.push(...pageResults);

        const coveredWholeMatch = records.length >= total;
        const hitRawCap = records.length >= GBIF_MAX_RAW_RECORDS;
        const shortPage = pageResults.length < GBIF_PAGE_LIMIT; // GBIF has nothing further to page through.
        if (coveredWholeMatch || hitRawCap || shortPage) break;

        offset += GBIF_PAGE_LIMIT;
    }

    return ok({ records, total });
}
