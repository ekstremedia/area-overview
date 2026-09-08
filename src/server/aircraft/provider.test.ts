import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import adsbLolFixture from './fixtures/adsb-lol-live.json' with { type: 'json' };
import {
    __resetOpenSkyStateForTests,
    bboxToCenterRadius,
    fetchAircraft,
    mapOpenSkyStatesToAircraft,
    mapRawV2AircraftToAircraft,
    mergeAircraft,
} from './provider.js';
import type { Aircraft } from '../../shared/schemas/aircraft.js';
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
        if (result.ok) expect(result.value.aircraft).toHaveLength(2);
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toMatch(/^https:\/\/api\.adsb\.lol\/v2\/lat\/69\/lon\/17\/dist\/\d+$/);
    });

    it('builds the right URL shape for airplanes.live and adsb.fi', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ac: [] }));

        await fetchAircraft(testBbox, { provider: 'airplaneslive', upstreamTimeoutMs: 5000, fetchImpl: fetchMock });
        expect((fetchMock.mock.calls[0] as [string])[0]).toMatch(/^https:\/\/api\.airplanes\.live\/v2\/point\//);

        await fetchAircraft(testBbox, { provider: 'adsbfi', upstreamTimeoutMs: 5000, fetchImpl: fetchMock });
        expect((fetchMock.mock.calls[1] as [string])[0]).toMatch(/^https:\/\/opendata\.adsb\.fi\/api\/v2\/lat\//);
    });

    it("reads adsb.fi's `aircraft` key as well as adsb.lol's `ac`, so the providers really are interchangeable", async () => {
        // Shipped broken once: `ADSB_PROVIDER=adsbfi` parsed every real
        // response as a schema failure, because adsb.fi returns the list
        // under `aircraft` while adsb.lol uses `ac`. The layer went
        // silently empty -- planes overhead, nothing on the map.
        const underAircraftKey = { aircraft: (adsbLolFixture as { ac: unknown[] }).ac };
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(underAircraftKey));

        const result = await fetchAircraft(testBbox, { provider: 'adsbfi', upstreamTimeoutMs: 5000, fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.aircraft).toHaveLength(2);
    });

    it('treats a response carrying neither key as an empty sky, not a malformed payload', async () => {
        // adsb.fi omits the key entirely when nothing is in range.
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ now: 1788796250.002, resultCount: 0 }));

        const result = await fetchAircraft(testBbox, { provider: 'adsbfi', upstreamTimeoutMs: 5000, fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.aircraft).toEqual([]);
    });

    it('returns an error on a non-OK response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
        const result = await fetchAircraft(testBbox, { provider: 'adsblol', upstreamTimeoutMs: 5000, fetchImpl: fetchMock });
        expect(result.ok).toBe(false);
    });

    it('reports the configured provider as the sole source when OpenSky is not configured', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ac: [] }));
        const result = await fetchAircraft(testBbox, { provider: 'adsbfi', upstreamTimeoutMs: 5000, fetchImpl: fetchMock });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.sources).toEqual(['adsbfi']);
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
            expect(result.value.aircraft).toHaveLength(1);
            expect(result.value.aircraft[0]?.icao).toBe('4ac9eb');
            expect(result.value.aircraft[0]?.callsign).toBe('SAS69L');
        }
    });
});

/** A `fetch` mock that never resolves on its own -- only rejects once its request's `AbortSignal` fires, same shape as `upstream.test.ts`'s own timeout test. */
function hangingFetch(): typeof fetch {
    return vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted', 'TimeoutError'));
            });
        });
    });
}

describe('fetchAircraft -- bounded timeouts on every upstream request', () => {
    it('fetchV2 (adsb.lol/airplanes.live/adsb.fi) resolves to err(...) rather than hanging when the request never settles', async () => {
        const fetchMock = hangingFetch();

        const result = await fetchAircraft(testBbox, { provider: 'adsblol', upstreamTimeoutMs: 1, fetchImpl: fetchMock });

        expect(result.ok).toBe(false);
    });

    it('fetchOpenSky (anonymous, no credentials) resolves to err(...) rather than hanging when the states request never settles', async () => {
        const fetchMock = hangingFetch();

        const result = await fetchAircraft(testBbox, { provider: 'opensky', upstreamTimeoutMs: 1, fetchImpl: fetchMock });

        expect(result.ok).toBe(false);
    });

    it('getOpenSkyBearerToken resolves to err(...) rather than hanging when the token request never settles', async () => {
        const fetchMock = hangingFetch();

        const result = await fetchAircraft(testBbox, {
            provider: 'opensky',
            openSkyCredentials: { clientId: 'id', clientSecret: 'secret' },
            upstreamTimeoutMs: 1,
            fetchImpl: fetchMock,
        });

        expect(result.ok).toBe(false);
        // The hang was on the token request, never reaching the states request.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('mergeAircraft', () => {
    function aircraft(icao: string, timestamp: string, lat = 68.7): Aircraft {
        return { icao, callsign: icao, lat, lng: 15.4, altitudeFt: 10000, groundSpeedKt: 200, track: 90, timestamp, trail: [] };
    }

    it('takes the union, since neither network is a superset of the other', () => {
        // Measured over Sortland: the ADS-B aggregators had one airliner
        // 45km away, OpenSky had a Widerøe flight overhead. Both belong.
        const merged = mergeAircraft([aircraft('aaa', '2026-09-07T16:00:00Z')], [aircraft('bbb', '2026-09-07T16:00:00Z')]);

        expect(merged.aircraft.map((a) => a.icao).sort()).toEqual(['aaa', 'bbb']);
        expect(merged.secondaryContributed).toBe(true);
    });

    it('keeps the fresher fix when both networks have the same aircraft', () => {
        const merged = mergeAircraft([aircraft('aaa', '2026-09-07T16:00:00Z', 68.1)], [aircraft('aaa', '2026-09-07T16:00:30Z', 68.9)]);

        expect(merged.aircraft).toHaveLength(1);
        expect(merged.aircraft[0]?.lat).toBe(68.9);
        expect(merged.secondaryContributed).toBe(true);
    });

    it('keeps the primary when it is the fresher of the two', () => {
        const merged = mergeAircraft([aircraft('aaa', '2026-09-07T16:00:30Z', 68.9)], [aircraft('aaa', '2026-09-07T16:00:00Z', 68.1)]);

        expect(merged.aircraft).toHaveLength(1);
        expect(merged.aircraft[0]?.lat).toBe(68.9);
        // Nothing of the secondary's survived, so it is not a source of
        // what the map is showing.
        expect(merged.secondaryContributed).toBe(false);
    });

    it('handles either side being empty', () => {
        expect(mergeAircraft([], [])).toEqual({ aircraft: [], secondaryContributed: false });
        expect(mergeAircraft([aircraft('aaa', '2026-09-07T16:00:00Z')], []).aircraft).toHaveLength(1);
        expect(mergeAircraft([], [aircraft('bbb', '2026-09-07T16:00:00Z')]).aircraft).toHaveLength(1);
    });
});

describe('OpenSky augmentation', () => {
    const CREDS = { clientId: 'id', clientSecret: 'secret' };
    const boxA: Bbox = { minLat: 68.5, minLng: 15.0, maxLat: 69.0, maxLng: 16.0 };
    // Overlapping but distinct -- under the old rounded cache key these two
    // collided and shared an answer.
    const boxB: Bbox = { minLat: 68.504, minLng: 15.004, maxLat: 69.004, maxLng: 16.004 };

    /** OpenSky's `states` tuple, trimmed to the fields the mapper reads. */
    function state(icao: string, lat: number, lon: number): unknown[] {
        return [icao, `${icao}   `, 'Norway', 1788790000, 1788790000, lon, lat, 3000, false, 200, 90, 0, null, 3100, null, false, 0];
    }

    function tokenResponse(): Response {
        return jsonResponse({ access_token: 'a-token', expires_in: 3600 });
    }

    /** OpenSky's states envelope -- `time` is required by the schema, so a mock without it fails validation before the mapper ever runs. */
    function statesResponse(...states: unknown[][]): Response {
        return jsonResponse({ time: 1788790000, states });
    }

    beforeEach(() => {
        __resetOpenSkyStateForTests();
    });

    afterEach(() => {
        vi.useRealTimers();
        __resetOpenSkyStateForTests();
    });

    it('spends one OpenSky request across two different boxes inside the interval', async () => {
        // The quota belongs to the account, not the rectangle: the browser's
        // viewport and the trail poller's fixed area must not each get their
        // own allowance.
        const fetchMock = vi.fn((url: string) => {
            if (url.includes('token')) return Promise.resolve(tokenResponse());
            if (url.includes('opensky')) return Promise.resolve(statesResponse(state('aaa111', 68.7, 15.5)));
            return Promise.resolve(jsonResponse({ ac: [] }));
        });

        await fetchAircraft(boxA, {
            provider: 'adsbfi',
            openSkyCredentials: CREDS,
            upstreamTimeoutMs: 5000,
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        await fetchAircraft(boxB, {
            provider: 'adsbfi',
            openSkyCredentials: CREDS,
            upstreamTimeoutMs: 5000,
            fetchImpl: fetchMock as unknown as typeof fetch,
        });

        const openSkyCalls = fetchMock.mock.calls.filter(([url]) => url.includes('opensky') && !url.includes('token'));
        expect(openSkyCalls).toHaveLength(1);
    });

    it('never returns an aircraft outside the requested box, even though it queries a wider one', async () => {
        // The query is padded so ordinary pans stay inside it; what comes
        // back still has to be narrowed to what the caller asked about.
        const fetchMock = vi.fn((url: string) => {
            if (url.includes('token')) return Promise.resolve(tokenResponse());
            if (url.includes('opensky')) {
                return Promise.resolve(
                    statesResponse(
                        state('inside', 68.7, 15.5),
                        state('outside', 69.4, 15.5), // inside the padded query, outside the caller's box
                    ),
                );
            }
            return Promise.resolve(jsonResponse({ ac: [] }));
        });

        const result = await fetchAircraft(boxA, {
            provider: 'adsbfi',
            openSkyCredentials: CREDS,
            upstreamTimeoutMs: 5000,
            fetchImpl: fetchMock as unknown as typeof fetch,
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.aircraft.map((a) => a.icao)).toEqual(['inside']);
    });

    it('serves the stale OpenSky snapshot when the primary provider fails', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-07T16:00:00Z'));

        let primaryOk = true;
        const fetchMock = vi.fn((url: string) => {
            if (url.includes('token')) return Promise.resolve(tokenResponse());
            if (url.includes('opensky')) return Promise.resolve(statesResponse(state('aaa111', 68.7, 15.5)));
            return primaryOk ? Promise.resolve(jsonResponse({ ac: [] })) : Promise.reject(new Error('network down'));
        });
        const options = {
            provider: 'adsbfi' as const,
            openSkyCredentials: CREDS,
            upstreamTimeoutMs: 5000,
            fetchImpl: fetchMock as unknown as typeof fetch,
        };

        await fetchAircraft(boxA, options); // fills the snapshot

        // Well past the interval, so the gate would allow a refresh -- but
        // now everything upstream is down.
        vi.setSystemTime(new Date('2026-09-07T16:10:00Z'));
        primaryOk = false;
        const failing = vi.fn(() => Promise.reject(new Error('network down')));
        const result = await fetchAircraft(boxA, { ...options, fetchImpl: failing });

        // The snapshot is stale, but it is real aircraft and beats an error.
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.aircraft.map((a) => a.icao)).toEqual(['aaa111']);
    });

    it('leaves the primary result untouched when OpenSky has nothing to add', async () => {
        const fetchMock = vi.fn((url: string) => {
            if (url.includes('token')) return Promise.resolve(tokenResponse());
            if (url.includes('opensky')) return Promise.reject(new Error('opensky down'));
            return Promise.resolve(jsonResponse(adsbLolFixture));
        });

        const result = await fetchAircraft(testBbox, {
            provider: 'adsbfi',
            openSkyCredentials: CREDS,
            upstreamTimeoutMs: 5000,
            fetchImpl: fetchMock as unknown as typeof fetch,
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.aircraft).toHaveLength(2);
    });

    it('names both sources when OpenSky actually contributes an aircraft', async () => {
        const fetchMock = vi.fn((url: string) => {
            if (url.includes('token')) return Promise.resolve(tokenResponse());
            if (url.includes('opensky')) return Promise.resolve(statesResponse(state('aaa111', 68.7, 15.5)));
            return Promise.resolve(jsonResponse({ ac: [] }));
        });

        const result = await fetchAircraft(boxA, {
            provider: 'adsbfi',
            openSkyCredentials: CREDS,
            upstreamTimeoutMs: 5000,
            fetchImpl: fetchMock as unknown as typeof fetch,
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.sources).toEqual(['adsbfi', 'opensky']);
    });

    it('does not name OpenSky when every aircraft it returned lost to a fresher primary fix', async () => {
        // OpenSky answering is not the same as OpenSky being in the answer:
        // a duplicate that loses the merge contributes nothing to what is on
        // screen, and crediting it would name a source of data nobody is
        // looking at.
        const fetchMock = vi.fn((url: string) => {
            if (url.includes('token')) return Promise.resolve(tokenResponse());
            // Stamped 1788790000 (2026-09-08T09:26:40Z) by `state()`.
            if (url.includes('opensky')) return Promise.resolve(statesResponse(state('aaa111', 68.7, 15.5)));
            // The same aircraft from the primary, seen just now -- the v2
            // mapper timestamps from `seen_pos` against the current clock,
            // so this is years fresher than OpenSky's fixed sample.
            return Promise.resolve(
                jsonResponse({ ac: [{ hex: 'aaa111', flight: 'WIF123 ', lat: 68.7, lon: 15.5, alt_baro: 3000, gs: 200, track: 90, seen_pos: 1 }] }),
            );
        });

        const result = await fetchAircraft(boxA, {
            provider: 'adsbfi',
            openSkyCredentials: CREDS,
            upstreamTimeoutMs: 5000,
            fetchImpl: fetchMock as unknown as typeof fetch,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.aircraft).toHaveLength(1);
            expect(result.value.sources).toEqual(['adsbfi']);
        }
    });

    it('does not name OpenSky when it has nothing to add', async () => {
        const fetchMock = vi.fn((url: string) => {
            if (url.includes('token')) return Promise.resolve(tokenResponse());
            if (url.includes('opensky')) return Promise.reject(new Error('opensky down'));
            return Promise.resolve(jsonResponse(adsbLolFixture));
        });

        const result = await fetchAircraft(testBbox, {
            provider: 'adsbfi',
            openSkyCredentials: CREDS,
            upstreamTimeoutMs: 5000,
            fetchImpl: fetchMock as unknown as typeof fetch,
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.sources).toEqual(['adsbfi']);
    });
});
