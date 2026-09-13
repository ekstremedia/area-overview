import { describe, expect, it, vi } from 'vitest';
import { RoadCameraSchema, RoadCameraSiteWeatherSchema } from '../../shared/schemas/road-cameras.js';
import type { Bbox } from '../layers/bbox.js';
import { createOutboundGate } from '../outbound-gate.js';
import cctvFixture from './fixtures/cctv-vesteralen.json' with { type: 'json' };
import weatherFixture from './fixtures/weather-vesteralen.json' with { type: 'json' };
import { fetchRoadCameras, mapRoadCameras, mapSiteWeather, MAX_PLAUSIBLE_WIND_MPS, siteIdOf } from './road-cameras.js';
import { CCTV_TYPE_NAME, type RawFeature } from './vegvesen-wfs.js';

const VESTERALEN: Bbox = { minLng: 14.5, minLat: 68.35, maxLng: 16.5, maxLat: 69.05 };

const CCTV_FEATURES = cctvFixture.features as unknown as RawFeature[];
const WEATHER_FEATURES = weatherFixture.features as unknown as RawFeature[];

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** What `fetchFeatures` actually asked for, however the `fetch` signature let it say so. */
function requestedUrl(input: string | URL | Request): string {
    if (typeof input === 'string') return input;
    return input instanceof URL ? input.toString() : input.url;
}

function wantsCameras(input: string | URL | Request): boolean {
    return requestedUrl(input).includes(encodeURIComponent(CCTV_TYPE_NAME));
}

/** A stub standing in for both WFS layers at once, dispatching on the `typeNames` in the URL the way the real GeoServer does. */
function wfsStub() {
    return vi.fn((url: string | URL | Request) => Promise.resolve(jsonResponse(wantsCameras(url) ? cctvFixture : weatherFixture)));
}

describe('siteIdOf', () => {
    it('reads the site out of `<siteId>_<n>`', () => {
        expect(siteIdOf('3000957_1')).toBe('3000957');
        expect(siteIdOf('3000957_12')).toBe('3000957');
    });

    it('treats a camera id with no orientation suffix as its own site', () => {
        expect(siteIdOf('3000957')).toBe('3000957');
    });
});

describe('mapRoadCameras', () => {
    const cameras = mapRoadCameras(CCTV_FEATURES);

    it("keeps one camera per orientation, all four sharing the site's coordinates", () => {
        const hadselbrua = cameras.filter((camera) => camera.siteId === '3000957');

        expect(hadselbrua).toHaveLength(4);
        expect(new Set(hadselbrua.map((camera) => `${String(camera.lat)},${String(camera.lng)}`)).size).toBe(1);
        expect(hadselbrua[0]?.name).toBe('Hadselbrua');
        expect(hadselbrua[0]?.direction).toBe('mot Stokmarknes');
    });

    it('drops a faulted camera rather than pinning a placeholder', () => {
        expect(cameras.map((camera) => camera.id)).not.toContain('3000700_1');
    });

    it("rejects a still image on a host that is not Vegvesen's", () => {
        // The visitor's browser fetches this URL directly, so the
        // assertion has to be here: nothing downstream can tell where an
        // `imageUrl` came from.
        expect(cameras.map((camera) => camera.id)).not.toContain('3000888_1');
        for (const camera of cameras) {
            expect(new URL(camera.imageUrl).hostname).toBe('kamera.atlas.vegvesen.no');
        }
    });

    it('carries a camera with no orientation and no road number', () => {
        const lodingen = cameras.find((camera) => camera.id === '3000905_1');

        expect(lodingen?.direction).toBeNull();
        expect(lodingen?.roadNumber).toBeNull();
    });

    it('swaps the point geometry into lat/lng', () => {
        // Upstream's coordinates are [14.98211, 68.55712].
        expect(cameras.find((camera) => camera.id === '3000957_1')).toMatchObject({ lat: 68.55712, lng: 14.98211 });
    });

    it('produces cameras that satisfy the shared contract', () => {
        expect(cameras).toHaveLength(7);
        for (const camera of cameras) {
            expect(() => RoadCameraSchema.parse(camera)).not.toThrow();
        }
    });

    it('drops a camera with no position at all', () => {
        const noGeometry: RawFeature[] = [
            {
                geometry: null,
                properties: {
                    CAMERA_ID: '3001111_1',
                    DESCRIPTION: 'Nowhere',
                    STATUS_STILL_IMAGE_AVAILABILITY: 'videoOrImagesAvailable',
                    STILL_IMAGE_URL: 'https://kamera.atlas.vegvesen.no/api/images/3001111_1',
                },
            },
        ];

        expect(mapRoadCameras(noGeometry)).toEqual([]);
    });
});

describe('mapSiteWeather', () => {
    const siteIds = new Set(mapRoadCameras(CCTV_FEATURES).map((camera) => camera.siteId));
    const weatherBySite = mapSiteWeather(WEATHER_FEATURES, siteIds);

    it('joins a station to the camera site it shares a reference id with', () => {
        expect(Object.keys(weatherBySite).sort()).toEqual(['3000420', '3000957']);
        expect(weatherBySite['3000957']).toMatchObject({ airTemperature: 7.2, roadTemperature: 8.9, measuredAt: '2026-09-13T11:50:00+02:00' });
    });

    it('ignores a weather station with no camera in the viewport', () => {
        // Blomjoten measures happily; there is simply no picture for it
        // to annotate.
        expect(weatherBySite['3009001']).toBeUndefined();
    });

    it('ignores the station at a site whose only camera was dropped', () => {
        expect(weatherBySite['3000700']).toBeUndefined();
    });

    it('ignores a reading with no measurement time', () => {
        expect(weatherBySite['3000905']).toBeUndefined();
    });

    it(`passes a believable wind reading through and discards one above ${String(MAX_PLAUSIBLE_WIND_MPS)} m/s`, () => {
        const tjeldsundbrua = weatherBySite['3000420'];

        // The 55 m/s outlier actually observed is implausible but within
        // what a Norwegian station could record, so it is shown; the 62
        // is past every wind speed ever measured on the mainland and is
        // not believed.
        expect(tjeldsundbrua?.windSpeed).toBe(55);
        expect(tjeldsundbrua?.windGust).toBeNull();
    });

    it('carries nulls as nulls, never as zeroes', () => {
        const hadselbrua = weatherBySite['3000957'];

        expect(hadselbrua?.windSpeed).toBeNull();
        expect(hadselbrua?.windGust).toBeNull();
        // A measured zero is a reading, and must survive as one.
        expect(hadselbrua?.precipitationIntensity).toBe(0);
    });

    it('produces readings that satisfy the shared contract', () => {
        for (const reading of Object.values(weatherBySite)) {
            expect(() => RoadCameraSiteWeatherSchema.parse(reading)).not.toThrow();
        }
    });
});

describe('fetchRoadCameras', () => {
    it('fetches both layers and joins them', async () => {
        const fetchMock = wfsStub();

        const result = await fetchRoadCameras(VESTERALEN, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.cameras).toHaveLength(7);
        expect(Object.keys(result.value.weatherBySite).sort()).toEqual(['3000420', '3000957']);
    });

    it('serves the cameras without readings when the weather layer fails', async () => {
        const fetchMock = vi.fn((url: string | URL | Request) =>
            wantsCameras(url) ? Promise.resolve(jsonResponse(cctvFixture)) : Promise.reject(new Error('weather down')),
        );
        const onWeatherFailure = vi.fn();

        const result = await fetchRoadCameras(VESTERALEN, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock, onWeatherFailure });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.cameras).toHaveLength(7);
        expect(result.value.weatherBySite).toEqual({});
        expect(onWeatherFailure).toHaveBeenCalledTimes(1);
    });

    it('fails when the camera layer itself fails', async () => {
        const result = await fetchRoadCameras(VESTERALEN, {
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockRejectedValue(new Error('network down')),
        });

        expect(result.ok).toBe(false);
    });

    it('spends the shared gate on the pictures before the temperatures', async () => {
        const fetchMock = wfsStub();
        // One token: the cameras take it, the weather is refused -- which
        // is the right way round for a request whose point is the picture.
        const gate = createOutboundGate({ minIntervalMs: 600_000, burst: 1 });

        const result = await fetchRoadCameras(VESTERALEN, { upstreamTimeoutMs: 1000, fetchImpl: fetchMock, gate });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.cameras).toHaveLength(7);
        expect(result.value.weatherBySite).toEqual({});
    });
});
