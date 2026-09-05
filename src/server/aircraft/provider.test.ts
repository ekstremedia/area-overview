import { describe, expect, it, vi } from 'vitest';
import adsbLolFixture from './fixtures/adsb-lol-live.json' with { type: 'json' };
import { bboxToCenterRadius, fetchAircraft, mapOpenSkyStatesToAircraft, mapRawV2AircraftToAircraft } from './provider.js';
import type { Bbox } from '../layers/bbox.js';

const NOW = new Date('2026-09-05T12:00:00.000Z');

// Covers Sortland/Vesterålen, which is where the live fixture's two
// aircraft were actually flying at capture time.
const testBbox: Bbox = { minLat: 68.0, minLng: 15.0, maxLat: 70.0, maxLng: 19.0 };

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('mapRawV2AircraftToAircraft (real adsb.lol fixture)', () => {
    const aircraft = mapRawV2AircraftToAircraft(adsbLolFixture.ac, testBbox, NOW);

    it('parses both real aircraft from the live capture', () => {
        expect(aircraft).toHaveLength(2);
    });

    it('trims trailing spaces from flight/callsign', () => {
        const sas = aircraft.find((a) => a.icao === '4ac9eb');
        expect(sas?.callsign).toBe('SAS69L');
    });

    it('falls back to hex when flight is empty after trimming', () => {
        const mapped = mapRawV2AircraftToAircraft([{ hex: 'abc123', flight: '   ', lat: 68.5, lon: 16.0, alt_baro: 1000 }], testBbox, NOW);
        expect(mapped[0]?.callsign).toBe('abc123');
    });

    it('falls back to hex when flight is entirely absent', () => {
        const mapped = mapRawV2AircraftToAircraft([{ hex: 'abc123', lat: 68.5, lon: 16.0, alt_baro: 1000 }], testBbox, NOW);
        expect(mapped[0]?.callsign).toBe('abc123');
    });

    it('passes a numeric alt_baro through unchanged', () => {
        const sas = aircraft.find((a) => a.icao === '4ac9eb');
        expect(sas?.altitudeFt).toBe(35750);
    });

    it('passes alt_baro: "ground" through unchanged', () => {
        const mapped = mapRawV2AircraftToAircraft([{ hex: 'ground01', lat: 68.5, lon: 16.0, alt_baro: 'ground' }], testBbox, NOW);
        expect(mapped[0]?.altitudeFt).toBe('ground');
    });

    it('computes an absolute timestamp from seen_pos, not seen', () => {
        const mapped = mapRawV2AircraftToAircraft([{ hex: 'time01', lat: 68.5, lon: 16.0, alt_baro: 1000, seen: 9, seen_pos: 3 }], testBbox, NOW);
        expect(mapped[0]?.timestamp).toBe(new Date(NOW.getTime() - 3000).toISOString());
    });

    it('drops entries with no position', () => {
        const mapped = mapRawV2AircraftToAircraft([{ hex: 'noposition', alt_baro: 1000 }], testBbox, NOW);
        expect(mapped).toHaveLength(0);
    });

    it('drops entries with no altitude data at all', () => {
        const mapped = mapRawV2AircraftToAircraft([{ hex: 'noalt', lat: 68.5, lon: 16.0 }], testBbox, NOW);
        expect(mapped).toHaveLength(0);
    });

    it('re-filters to the exact bbox, dropping a point outside it even if within the query radius', () => {
        const mapped = mapRawV2AircraftToAircraft([{ hex: 'faraway', lat: 40.0, lon: 16.0, alt_baro: 1000 }], testBbox, NOW);
        expect(mapped).toHaveLength(0);
    });
});

describe('bboxToCenterRadius', () => {
    it('returns a radius clamped to at least the minimum', () => {
        const tiny: Bbox = { minLat: 68.0, minLng: 15.0, maxLat: 68.01, maxLng: 15.01 };
        expect(bboxToCenterRadius(tiny).nm).toBeGreaterThanOrEqual(5);
    });

    it('returns a radius clamped to at most the maximum', () => {
        const huge: Bbox = { minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 };
        expect(bboxToCenterRadius(huge).nm).toBeLessThanOrEqual(250);
    });

    it('centers on the bbox midpoint', () => {
        const { lat, lon } = bboxToCenterRadius(testBbox);
        expect(lat).toBeCloseTo(69.0);
        expect(lon).toBeCloseTo(17.0);
    });

    // Mirrors provider.ts's own (private) constants so this test can compute
    // the true, correct center-to-corner distance independently, without
    // reaching into the module's internals.
    const KM_PER_DEGREE_LAT = 111;
    const KM_PER_NM = 1.852;

    /** The true center-to-corner distance (km) for a bbox, using each corner's OWN latitude for the longitude->km conversion -- the geometrically correct baseline this fix's radius must cover. */
    function trueMaxCornerKm(bbox: Bbox): number {
        const latHalfKm = ((bbox.maxLat - bbox.minLat) / 2) * KM_PER_DEGREE_LAT;
        const lngHalfDeg = (bbox.maxLng - bbox.minLng) / 2;
        const cornerKmAt = (lat: number) => Math.hypot(latHalfKm, lngHalfDeg * KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
        return Math.max(cornerKmAt(bbox.minLat), cornerKmAt(bbox.maxLat));
    }

    it('covers the true center-to-corner distance for an asymmetric-latitude bbox at high latitude, where a center-cosine approximation under-covers', () => {
        // Wide longitude span, narrow-ish latitude span, anchored at this
        // app's real deployment latitude (~68-69°N): the corner farther from
        // the equator (70°N) needs a noticeably smaller cosine factor than
        // the bbox's 69°N center, so a center-based estimate under-shoots.
        const bbox: Bbox = { minLat: 68.0, minLng: 15.0, maxLat: 70.0, maxLng: 25.0 };

        const { nm } = bboxToCenterRadius(bbox);
        const requiredNm = trueMaxCornerKm(bbox) / KM_PER_NM;

        // The old center-cosine-based formula rounded to 123nm here; the
        // true required radius is ~127.26nm. The fix must cover it.
        expect(requiredNm).toBeGreaterThan(123);
        expect(nm).toBeGreaterThanOrEqual(requiredNm);
    });

    it('rounds the radius UP, not to nearest, so a fractional required radius is never under-covered', () => {
        // The true required radius here is ~64.0025nm -- close enough to a
        // whole number that naive `Math.round` (or even truncation) would
        // still land on 64nm, one hair short of covering the actual corner.
        const bbox: Bbox = { minLat: 68.0, minLng: 15.0, maxLat: 70.0, maxLng: 17.0 };

        const { nm } = bboxToCenterRadius(bbox);
        const requiredNm = trueMaxCornerKm(bbox) / KM_PER_NM;

        expect(Math.round(requiredNm)).toBeLessThan(requiredNm); // confirms this case actually exercises the rounding boundary
        expect(nm).toBeGreaterThanOrEqual(requiredNm);
    });
});

describe('fetchAircraft (v2 providers)', () => {
    it('fetches from adsb.lol and maps the response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(adsbLolFixture));

        const result = await fetchAircraft(testBbox, { provider: 'adsblol', upstreamTimeoutMs: 5000, fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toHaveLength(2);
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toMatch(/^https:\/\/api\.adsb\.lol\/v2\/lat\/69\/lon\/17\/dist\/\d+$/);
    });

    it('builds the right URL shape for airplanes.live and adsb.fi', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ac: [] }));

        await fetchAircraft(testBbox, { provider: 'airplaneslive', fetchImpl: fetchMock });
        expect((fetchMock.mock.calls[0] as [string])[0]).toMatch(/^https:\/\/api\.airplanes\.live\/v2\/point\//);

        await fetchAircraft(testBbox, { provider: 'adsbfi', fetchImpl: fetchMock });
        expect((fetchMock.mock.calls[1] as [string])[0]).toMatch(/^https:\/\/opendata\.adsb\.fi\/api\/v2\/lat\//);
    });

    it('returns an error on a non-OK response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
        const result = await fetchAircraft(testBbox, { provider: 'adsblol', fetchImpl: fetchMock });
        expect(result.ok).toBe(false);
    });
});

describe('mapOpenSkyStatesToAircraft (best-effort, documented-only shape)', () => {
    it('maps an airborne state vector', () => {
        const state: Parameters<typeof mapOpenSkyStatesToAircraft>[0][number] = [
            '4ac9eb',
            'SAS69L  ',
            'Sweden',
            1_788_582_820,
            1_788_582_821,
            16.700592,
            68.240067,
            10897.0, // meters
            false,
            232.5, // m/s
            204.86,
            0,
            null,
            10500.0,
            '4204',
            false,
            0,
        ];

        const [aircraft] = mapOpenSkyStatesToAircraft([state]);

        expect(aircraft?.icao).toBe('4ac9eb');
        expect(aircraft?.callsign).toBe('SAS69L');
        expect(aircraft?.altitudeFt).toBeCloseTo(10897.0 / 0.3048);
        expect(aircraft?.groundSpeedKt).toBeCloseTo(232.5 * 1.94384);
        expect(aircraft?.timestamp).toBe(new Date(1_788_582_820 * 1000).toISOString());
    });

    it('maps an on-ground state vector to altitudeFt: "ground"', () => {
        const state: Parameters<typeof mapOpenSkyStatesToAircraft>[0][number] = [
            'abc123',
            null,
            'Norway',
            1_788_582_820,
            1_788_582_821,
            16.0,
            68.5,
            null,
            true,
            0,
            0,
            0,
            null,
            null,
            null,
            false,
            0,
        ];

        const [aircraft] = mapOpenSkyStatesToAircraft([state]);

        expect(aircraft?.altitudeFt).toBe('ground');
        expect(aircraft?.callsign).toBe('abc123'); // falls back to icao24 when callsign is null
    });

    it('drops a state vector with no position', () => {
        const state: Parameters<typeof mapOpenSkyStatesToAircraft>[0][number] = [
            'noposition',
            null,
            null,
            1_788_582_820,
            1_788_582_821,
            null,
            null,
            null,
            false,
            null,
            null,
            null,
            null,
            null,
            null,
            false,
            null,
        ];

        expect(mapOpenSkyStatesToAircraft([state])).toHaveLength(0);
    });
});

describe('fetchAircraft (opensky provider) -- schema tolerance for trailing fields', () => {
    it('accepts a state vector with an extra trailing element (e.g. the real API\'s "category" field) rather than rejecting the whole payload', async () => {
        const stateWithCategory = [
            '4ac9eb',
            'SAS69L  ',
            'Sweden',
            1_788_582_820,
            1_788_582_821,
            16.700592,
            68.240067,
            10897.0,
            false,
            232.5,
            204.86,
            0,
            null,
            10500.0,
            '4204',
            false,
            0,
            0, // 18th element: `category`, undocumented at the time this schema was first written
        ];
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ time: 1_788_582_820, states: [stateWithCategory] }));

        const result = await fetchAircraft(testBbox, { provider: 'opensky', upstreamTimeoutMs: 5000, fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toHaveLength(1);
            expect(result.value[0]?.icao).toBe('4ac9eb');
            expect(result.value[0]?.callsign).toBe('SAS69L');
        }
    });
});
