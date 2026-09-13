import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoadCamerasResponseSchema } from '../../shared/schemas/road-cameras.js';
import cctvFixture from '../roads/fixtures/cctv-vesteralen.json' with { type: 'json' };
import weatherFixture from '../roads/fixtures/weather-vesteralen.json' with { type: 'json' };
import { CCTV_TYPE_NAME } from '../roads/vegvesen-wfs.js';
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

const VALID_BBOX = 'bbox=14.5,68.35,16.5,69.05';

/** One stub for both WFS layers, dispatching on `typeNames` the way the real GeoServer does. */
function wfsStub(): ReturnType<typeof vi.fn> {
    return vi
        .fn()
        .mockImplementation((url: unknown) =>
            Promise.resolve(jsonResponse(String(url).includes(encodeURIComponent(CCTV_TYPE_NAME)) ? cctvFixture : weatherFixture)),
        );
}

describe('GET /api/road-cameras', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serves the cameras in a viewport with the road weather joined by site', async () => {
        vi.stubGlobal('fetch', wfsStub());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = RoadCamerasResponseSchema.parse(response.json());
        expect(body.cameras.filter((camera) => camera.siteId === '3000957')).toHaveLength(4);
        expect(body.weatherBySite['3000957']?.roadTemperature).toBe(8.9);
        expect(typeof body.fetchedAt).toBe('string');
    });

    it('serves no faulted camera, and no image from another host', async () => {
        vi.stubGlobal('fetch', wfsStub());
        const app = buildTestApp();

        const body = RoadCamerasResponseSchema.parse((await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` })).json());

        expect(body.cameras.map((camera) => camera.id)).not.toContain('3000700_1');
        for (const camera of body.cameras) {
            expect(new URL(camera.imageUrl).hostname).toBe('kamera.atlas.vegvesen.no');
        }
    });

    it('serves no readings for a station with no camera in the viewport', async () => {
        vi.stubGlobal('fetch', wfsStub());
        const app = buildTestApp();

        const body = RoadCamerasResponseSchema.parse((await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` })).json());

        expect(Object.keys(body.weatherBySite).sort()).toEqual(['3000420', '3000957']);
    });

    it('asks the GeoServer for both layers, longitude-first', async () => {
        const fetchMock = wfsStub();
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });

        const typeNames = fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('typeNames'));
        expect(typeNames).toEqual(['datex_3_1:CctvSimple_v2', 'datex_3_1:WeatherSimple_v2']);
        expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('bbox')).toBe('14.5,68.35,16.5,69.05,EPSG:4326');
    });

    it('responds 400 for an unparseable bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/road-cameras?bbox=nope' });

        expect(response.statusCode).toBe(400);
    });

    it('responds 400 for a missing bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/road-cameras' });

        expect(response.statusCode).toBe(400);
    });

    it('serves a stale answer rather than calling upstream when the shared Vegvesen gate is shut', async () => {
        const fetchMock = wfsStub();
        vi.stubGlobal('fetch', fetchMock);
        // Two tokens and a ten-minute refill: the warm-up request spends
        // both (cameras, then weather), so the next one finds the gate shut.
        const app = buildTestApp({ roadCamerasCacheTtlMs: 10, vegvesenMinIntervalMs: 600_000, vegvesenBurst: 2 });

        expect((await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` })).statusCode).toBe(200);
        await sleep(20);

        const gated = await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });

        expect(gated.statusCode).toBe(200);
        expect(gated.headers['x-cache']).toBe('stale');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('responds 502 when the gate is shut and nothing has been cached yet', async () => {
        const fetchMock = wfsStub();
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ vegvesenMinIntervalMs: 600_000, vegvesenBurst: 2 });

        await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });
        // A neighbouring viewport, so this is unambiguously a cache miss.
        const gated = await app.inject({ method: 'GET', url: '/api/road-cameras?bbox=14.55,68.4,16.45,69.0' });

        expect(gated.statusCode).toBe(502);
    });

    it('makes one pair of upstream calls for two requests inside the TTL', async () => {
        const fetchMock = wfsStub();
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ roadCamerasCacheTtlMs: 60_000 });

        await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });
        const second = await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });

        expect(second.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('serves a stale answer when the GeoServer fails after a warm cache', async () => {
        const fetchMock = wfsStub();
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ roadCamerasCacheTtlMs: 10 });

        expect((await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` })).statusCode).toBe(200);
        await sleep(20);
        fetchMock.mockRejectedValue(new Error('GeoServer down'));

        const stale = await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
    });

    it('responds 502 on a cold cache when the GeoServer is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('GeoServer down')));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });

        expect(response.statusCode).toBe(502);
    });

    it('advertises freshness from its own, longer TTL', async () => {
        vi.stubGlobal('fetch', wfsStub());
        const app = buildTestApp({ roadCamerasCacheTtlMs: 300_000 });

        const response = await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });

        expect(response.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=60');
    });

    it('still serves the pictures when only the weather layer fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockImplementation((url: unknown) =>
                    String(url).includes(encodeURIComponent(CCTV_TYPE_NAME))
                        ? Promise.resolve(jsonResponse(cctvFixture))
                        : Promise.reject(new Error('weather down')),
                ),
        );
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/road-cameras?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = RoadCamerasResponseSchema.parse(response.json());
        expect(body.cameras.length).toBeGreaterThan(0);
        expect(body.weatherBySite).toEqual({});
    });
});
