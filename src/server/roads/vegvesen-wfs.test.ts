import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bbox } from '../layers/bbox.js';
import { createOutboundGate } from '../outbound-gate.js';
import situationsFixture from './fixtures/situations-vesteralen.json' with { type: 'json' };
import { mapSituations } from './situations.js';
import { fetchFeatures, SITUATION_QUERY_EXTRA, SITUATIONS_TYPE_NAME, VEGVESEN_WFS_URL, wfsQuery } from './vegvesen-wfs.js';

/** The Vesterålen box from `fixtures/README.md`'s "Re-probing" commands -- 54 records, 26 situations, 0.2s. */
const VESTERALEN: Bbox = { minLng: 14.5, minLat: 68.35, maxLng: 16.5, maxLat: 69.05 };

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('wfsQuery', () => {
    it('emits the bbox longitude-first, with the CRS appended', () => {
        // The probed trap, pinned as a literal: the lat-first order the
        // WFS spec suggests for EPSG:4326 does not error, it matches
        // nothing at all (0 hits versus 54 for this exact box). A
        // reversed bbox therefore looks like "no roadworks near you",
        // which is a believable answer, so nothing but this assertion
        // would ever catch it.
        expect(wfsQuery(SITUATIONS_TYPE_NAME, VESTERALEN).get('bbox')).toBe('14.5,68.35,16.5,69.05,EPSG:4326');
    });

    it('asks for WFS 2.0.0 GeoJSON in EPSG:4326', () => {
        const query = wfsQuery(SITUATIONS_TYPE_NAME, VESTERALEN);

        expect(query.get('service')).toBe('WFS');
        expect(query.get('version')).toBe('2.0.0');
        expect(query.get('request')).toBe('GetFeature');
        expect(query.get('typeNames')).toBe('datex_3_1:SituationSimple_v2');
        expect(query.get('outputFormat')).toBe('application/json');
        expect(query.get('srsName')).toBe('EPSG:4326');
    });

    it("merges the situations layer's cap and sort order", () => {
        const query = wfsQuery(SITUATIONS_TYPE_NAME, VESTERALEN, SITUATION_QUERY_EXTRA);

        expect(query.get('count')).toBe('500');
        expect(query.get('sortBy')).toBe('LAST_UPDATE_TIME D');
    });
});

describe('fetchFeatures', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns the collection's features, parsed tolerantly", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(situationsFixture));

        const result = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.length).toBe(situationsFixture.features.length);
        // Order is upstream's -- `sortBy=LAST_UPDATE_TIME D`, so the most
        // recently edited record first -- and is passed through untouched.
        expect(result.value[0]?.properties?.RECORD_ID).toBe('NPRA_1009_1');
        expect(result.value.at(-1)?.properties?.RECORD_ID).toBe('NPRA_1011_1');
    });

    it('calls the GeoServer at its documented URL', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ type: 'FeatureCollection', features: [] }));

        await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock });

        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`${VEGVESEN_WFS_URL}?`);
    });

    it('falls back to the global fetch when no implementation is injected', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ type: 'FeatureCollection', features: [] }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, { upstreamTimeoutMs: 1000 });

        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads a collection with no features key as an empty viewport', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ type: 'FeatureCollection' }));

        const result = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock });

        expect(result).toEqual({ ok: true, value: [] });
    });

    it('keeps a feature whose geometry type this app does not draw, with a null geometry', async () => {
        // An unknown geometry must cost a line on the map, not the whole
        // response: the situation still has its own display coordinates.
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({
                type: 'FeatureCollection',
                features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[15, 68]]] }, properties: { SITUATION_ID: 'x' } }],
            }),
        );

        const result = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.geometry).toBeNull();
    });

    it('keeps the good features in a collection where one feature is malformed', async () => {
        // The failure mode this prevents: one feature published without
        // an attribute bag (or with something that is not one) failing
        // the whole collection and blanking a viewport that had 499
        // perfectly good records in it.
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({
                type: 'FeatureCollection',
                features: [
                    { type: 'Feature', geometry: null, properties: { SITUATION_ID: 'good-1' } },
                    { type: 'Feature', geometry: null, properties: 'not an attribute bag' },
                    { type: 'Feature', geometry: null },
                    { type: 'Feature', geometry: null, properties: { SITUATION_ID: 'good-2' } },
                ],
            }),
        );

        const result = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(4);
        expect(result.value.map((feature) => feature.properties?.SITUATION_ID)).toEqual(['good-1', undefined, undefined, 'good-2']);
        // The two malformed ones arrive with nothing in them, which is
        // what makes the mappers skip them one by one.
        expect(result.value[1]?.properties).toBeNull();
        expect(result.value[2]?.properties).toBeNull();
        // And the mapper really does skip them rather than emitting junk.
        expect(mapSituations(result.value, new Date('2026-09-13T12:00:00+02:00'))).toEqual([]);
    });

    it('reports a network failure, a bad status and a non-JSON body as errors', async () => {
        const failed = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, {
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockRejectedValue(new Error('network down')),
        });
        const badStatus = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, {
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
        });
        const notJson = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, {
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
        });

        expect(failed.ok).toBe(false);
        expect(badStatus.ok).toBe(false);
        expect(notJson.ok).toBe(false);
    });

    it('reports a shut gate as an ordinary error without calling upstream', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(situationsFixture));
        // One token, refilled in ten minutes: the first call spends it.
        const gate = createOutboundGate({ minIntervalMs: 600_000, burst: 1 });

        const first = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, { upstreamTimeoutMs: 1000, gate, fetchImpl: fetchMock });
        const second = await fetchFeatures(SITUATIONS_TYPE_NAME, VESTERALEN, { upstreamTimeoutMs: 1000, gate, fetchImpl: fetchMock });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        // The whole point of a gate: the refusal cost nothing outbound.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
