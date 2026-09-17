import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bbox } from '../layers/bbox.js';
import { createOutboundGate } from '../outbound-gate.js';
import regionsFixture from './fixtures/nve-regions-northern-norway.json' with { type: 'json' };
import { NVE_REGIONS_URL, createRegionsSource, fetchRegions, regionsIntersecting } from './regions.js';

/** The Vesterålen/Ofoten test bbox shared across the warnings fixtures -- see `fixtures/README.md`. */
const TEST_BBOX: Bbox = { minLat: 68.35, minLng: 14.5, maxLat: 69.05, maxLng: 16.5 };
/** Nowhere near any region in the fixture (Bergen-ish). */
const FAR_AWAY_BBOX: Bbox = { minLat: 60.0, minLng: 5.0, maxLat: 60.3, maxLng: 5.5 };

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('fetchRegions', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('parses the region roster, converting each Polygon string into [lat, lng] tuples', async () => {
        const result = await fetchRegions({ upstreamTimeoutMs: 1000, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(regionsFixture)) });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(regionsFixture.length);
        const vesteralen = result.value.find((region) => region.regionId === '3003');
        expect(vesteralen?.regionName).toBe('Vesterålen');
        expect(vesteralen?.outline[0]).toEqual([68.3, 14.2]);
    });

    it('asks the Region endpoint with no query parameters', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(regionsFixture));

        await fetchRegions({ upstreamTimeoutMs: 1000, fetchImpl: fetchMock });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toBe(NVE_REGIONS_URL);
    });

    it('reports a network failure, a bad status and a non-JSON body as errors', async () => {
        const failed = await fetchRegions({ upstreamTimeoutMs: 1000, fetchImpl: vi.fn().mockRejectedValue(new Error('down')) });
        const badStatus = await fetchRegions({
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
        });
        const notJson = await fetchRegions({
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
        });

        expect(failed.ok).toBe(false);
        expect(badStatus.ok).toBe(false);
        expect(notJson.ok).toBe(false);
    });

    it('reports an error when a non-empty roster has no region with a usable Polygon, rather than ok([])', async () => {
        const degraded = [
            { Id: 3003, Name: 'Vesterålen', TypeName: 'A', Polygon: null },
            { Id: 3004, Name: 'Ofoten', TypeName: 'A' }, // Polygon absent entirely
            { Id: 3010, Name: 'Nord-Troms', TypeName: 'A', Polygon: ['68.1,15.4'] }, // one point only, < 3
        ];

        const result = await fetchRegions({ upstreamTimeoutMs: 1000, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(degraded)) });

        expect(result.ok).toBe(false);
    });

    it('still returns ok([]) for a genuinely empty roster (zero raw entries)', async () => {
        const result = await fetchRegions({ upstreamTimeoutMs: 1000, fetchImpl: vi.fn().mockResolvedValue(jsonResponse([])) });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toEqual([]);
    });

    it('reports a shut gate as an ordinary error without calling upstream', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(regionsFixture));
        const gate = createOutboundGate({ minIntervalMs: 600_000, burst: 1 });

        const first = await fetchRegions({ upstreamTimeoutMs: 1000, gate, fetchImpl: fetchMock });
        const second = await fetchRegions({ upstreamTimeoutMs: 1000, gate, fetchImpl: fetchMock });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('regionsIntersecting', () => {
    it('returns both regions a bbox touches, each with the centroid of its own intersection', async () => {
        const result = await fetchRegions({ upstreamTimeoutMs: 1000, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(regionsFixture)) });
        if (!result.ok) throw new Error('fixture fetch failed');

        const hits = regionsIntersecting(result.value, TEST_BBOX);

        const ids = hits.map((hit) => hit.region.regionId).sort();
        expect(ids).toEqual(['3003', '3004']);
        for (const hit of hits) {
            expect(hit.point.lat).toBeGreaterThanOrEqual(TEST_BBOX.minLat);
            expect(hit.point.lat).toBeLessThanOrEqual(TEST_BBOX.maxLat);
        }
    });

    it('returns an empty array, not an error, for a bbox touching no region', async () => {
        const result = await fetchRegions({ upstreamTimeoutMs: 1000, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(regionsFixture)) });
        if (!result.ok) throw new Error('fixture fetch failed');

        const hits = regionsIntersecting(result.value, FAR_AWAY_BBOX);

        expect(hits).toEqual([]);
    });

    it('places the centroid inside the bbox when the bbox sits entirely inside the region', async () => {
        const result = await fetchRegions({ upstreamTimeoutMs: 1000, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(regionsFixture)) });
        if (!result.ok) throw new Error('fixture fetch failed');

        // Entirely inside Vesterålen's rectangle (68.30..69.00, 14.20..15.60).
        const insideBbox: Bbox = { minLat: 68.5, minLng: 14.6, maxLat: 68.6, maxLng: 14.8 };
        const hits = regionsIntersecting(result.value, insideBbox);

        const vesteralen = hits.find((hit) => hit.region.regionId === '3003');
        expect(vesteralen).toBeDefined();
        expect(vesteralen?.point.lat).toBeCloseTo(68.55, 5);
        expect(vesteralen?.point.lng).toBeCloseTo(14.7, 5);
    });
});

describe('createRegionsSource', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serves a stale roster when NVE fails after a warm cache', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(regionsFixture));
        const source = createRegionsSource(10, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock });

        const first = await source.get();
        expect(first?.stale).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 20));
        fetchMock.mockRejectedValue(new Error('NVE down'));

        const second = await source.get();
        expect(second?.stale).toBe(true);
        expect(second?.regions).toHaveLength(regionsFixture.length);
    });

    it('returns undefined on a cold cache when NVE is unreachable', async () => {
        const source = createRegionsSource(10, { upstreamTimeoutMs: 1000, fetchImpl: vi.fn().mockRejectedValue(new Error('NVE down')) });

        const result = await source.get();

        expect(result).toBeUndefined();
    });
});
