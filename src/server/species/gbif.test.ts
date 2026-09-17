import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bbox } from '../layers/bbox.js';
import { createOutboundGate } from '../outbound-gate.js';
import fixture from './fixtures/gbif-occurrence-search-vesteralen.json' with { type: 'json' };
import { bboxToWkt, eventDateRange, fetchGbifOccurrences, GBIF_MAX_RAW_RECORDS, GBIF_OCCURRENCE_SEARCH_URL, GBIF_PAGE_LIMIT } from './gbif.js';
import type { RawOccurrenceRecord } from './gbif.js';

/** The Vesterålen box from the fixtures' README. */
const VESTERALEN: Bbox = { minLat: 68.35, minLng: 14.5, maxLat: 69.05, maxLng: 16.5 };

const TEST_USER_AGENT = 'area-overview-test/0.1 (+https://area.nesthus.no; terjen@gmail.com)';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A page-shaped envelope with `count` records, all distinct, for pagination tests. */
function pageOf(count: number, offset: number, total: number): { count: number; results: RawOccurrenceRecord[] } {
    const results: RawOccurrenceRecord[] = [];
    for (let i = 0; i < count; i += 1) {
        const n = offset + i;
        results.push({
            speciesKey: n,
            scientificName: `Species number ${String(n)}`,
            kingdom: 'Animalia',
            class: 'Aves',
            eventDate: '2026-09-01',
            decimalLatitude: 60,
            decimalLongitude: 10,
            license: 'http://creativecommons.org/licenses/by/4.0/legalcode',
            datasetKey: 'synthetic',
        });
    }
    return { count: total, results };
}

describe('bboxToWkt', () => {
    it('builds a closed POLYGON with longitude first', () => {
        // The trap this pins: GBIF's `geometry` is longitude-first WKT,
        // the mirror image of this app's own [lat,lng] convention, and the
        // ring must be explicitly closed by repeating the first point.
        const wkt = bboxToWkt(VESTERALEN);

        expect(wkt.startsWith('POLYGON((')).toBe(true);
        expect(wkt).toContain('14.5 68.35');
        expect(wkt).toContain('16.5 69.05');
        // Closed: the first and last coordinate pairs match.
        const coords = wkt.replace('POLYGON((', '').replace('))', '').split(',');
        expect(coords[0]).toBe(coords[coords.length - 1]);
    });
});

describe('eventDateRange', () => {
    it('builds a from,to range of exactly `days` in UTC date form', () => {
        const now = new Date('2026-09-17T12:00:00Z');

        const range = eventDateRange(30, now);

        expect(range).toBe('2026-08-18,2026-09-17');
    });
});

describe('fetchGbifOccurrences', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the raw records and the envelope total for a successful response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixture));

        const result = await fetchGbifOccurrences(VESTERALEN, 30, new Date('2026-09-17T12:00:00Z'), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            fetchImpl: fetchMock,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.records).toHaveLength(fixture.results.length);
        expect(result.value.total).toBe(fixture.count);
    });

    it('GETs once, carrying the WKT geometry, the eventDate range, PRESENT-only and a capped limit, identifying itself', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixture));

        await fetchGbifOccurrences(VESTERALEN, 30, new Date('2026-09-17T12:00:00Z'), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            fetchImpl: fetchMock,
        });

        // Only one page fetched: this fixture's own `count` (7) fits inside one page.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
        expect(url.origin + url.pathname).toBe(GBIF_OCCURRENCE_SEARCH_URL);
        expect(url.searchParams.get('geometry')).toContain('POLYGON((');
        expect(url.searchParams.get('hasCoordinate')).toBe('true');
        expect(url.searchParams.get('hasGeospatialIssue')).toBe('false');
        expect(url.searchParams.get('occurrenceStatus')).toBe('PRESENT');
        expect(url.searchParams.get('eventDate')).toBe('2026-08-18,2026-09-17');
        expect(url.searchParams.get('limit')).toBe(String(GBIF_PAGE_LIMIT));
        expect(url.searchParams.get('offset')).toBe('0');
        expect((init.headers as Record<string, string>)['User-Agent']).toBe(TEST_USER_AGENT);
    });

    it('reports a network failure, a bad status and a non-JSON body as errors', async () => {
        const failed = await fetchGbifOccurrences(VESTERALEN, 30, new Date(), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            fetchImpl: vi.fn().mockRejectedValue(new Error('network down')),
        });
        const badStatus = await fetchGbifOccurrences(VESTERALEN, 30, new Date(), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
        });
        const notJson = await fetchGbifOccurrences(VESTERALEN, 30, new Date(), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
        });

        expect(failed.ok).toBe(false);
        expect(badStatus.ok).toBe(false);
        expect(notJson.ok).toBe(false);
    });

    it('reports a shut gate as an ordinary error without calling upstream', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixture));
        // One token, refilled in ten minutes: the first call spends it.
        const gate = createOutboundGate({ minIntervalMs: 600_000, burst: 1 });

        const first = await fetchGbifOccurrences(VESTERALEN, 30, new Date(), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            gate,
            fetchImpl: fetchMock,
        });
        const second = await fetchGbifOccurrences(VESTERALEN, 30, new Date(), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            gate,
            fetchImpl: fetchMock,
        });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        // The whole point of a gate: the refusal cost nothing outbound.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('pages via offset when the match set exceeds one page, stopping once `total` is covered', async () => {
        // 7 real matches spread over 3 pages of GBIF_PAGE_LIMIT (300) each,
        // with a final short page -- exercises both the offset increment
        // and the "short page means no more data" stop condition.
        const total = GBIF_PAGE_LIMIT * 2 + 7;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(pageOf(GBIF_PAGE_LIMIT, 0, total)))
            .mockResolvedValueOnce(jsonResponse(pageOf(GBIF_PAGE_LIMIT, GBIF_PAGE_LIMIT, total)))
            .mockResolvedValueOnce(jsonResponse(pageOf(7, GBIF_PAGE_LIMIT * 2, total)));

        const result = await fetchGbifOccurrences(VESTERALEN, 30, new Date(), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            fetchImpl: fetchMock,
        });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        const offsets = fetchMock.mock.calls.map((call) => (call[0] as URL).searchParams.get('offset'));
        expect(offsets).toEqual(['0', String(GBIF_PAGE_LIMIT), String(GBIF_PAGE_LIMIT * 2)]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.records).toHaveLength(total);
        expect(result.value.total).toBe(total);
    });

    it('stops paging at GBIF_MAX_RAW_RECORDS even when far more matched, without fetching a partial page beyond the cap', async () => {
        const total = GBIF_MAX_RAW_RECORDS * 10; // deliberately far beyond what paging will ever cover
        const fetchMock = vi.fn().mockImplementation((url: URL) => {
            const offset = Number(url.searchParams.get('offset'));
            return Promise.resolve(jsonResponse(pageOf(GBIF_PAGE_LIMIT, offset, total)));
        });

        const result = await fetchGbifOccurrences(VESTERALEN, 365, new Date(), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            fetchImpl: fetchMock,
        });

        // GBIF_MAX_RAW_RECORDS / GBIF_PAGE_LIMIT full pages, no more.
        expect(fetchMock).toHaveBeenCalledTimes(GBIF_MAX_RAW_RECORDS / GBIF_PAGE_LIMIT);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.records).toHaveLength(GBIF_MAX_RAW_RECORDS);
        expect(result.value.total).toBe(total); // still reports the true total, for `truncated`'s sake
    });

    it('degrades to what was already fetched, rather than failing the whole call, when a later page fails', async () => {
        const total = GBIF_PAGE_LIMIT * 2;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(pageOf(GBIF_PAGE_LIMIT, 0, total)))
            .mockRejectedValueOnce(new Error('GBIF down mid-page'));

        const result = await fetchGbifOccurrences(VESTERALEN, 30, new Date(), {
            upstreamTimeoutMs: 1000,
            userAgent: TEST_USER_AGENT,
            fetchImpl: fetchMock,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.records).toHaveLength(GBIF_PAGE_LIMIT); // only the first page's worth
        expect(result.value.total).toBe(total);
    });
});
