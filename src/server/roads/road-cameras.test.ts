import { describe, expect, it, vi } from 'vitest';
import { RoadCameraSchema, RoadCameraSiteWeatherSchema, type RoadCameraSiteWeather } from '../../shared/schemas/road-cameras.js';
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

    it('drops a gust that is nearly four times its own mean, and keeps the mean', () => {
        const tjeldsundbrua = weatherBySite['3000420'];

        // Real data, fetched through this route on 2026-09-13: a 54.4 m/s
        // gust (196 km/h) against a 14.8 m/s mean on a 9 °C September
        // evening -- a gust factor of 3.7 where the weather produces
        // 1.3-1.6. Under a 60 m/s cutoff alone it went onto the wall
        // display as a hurricane.
        expect(tjeldsundbrua?.windSpeed).toBe(14.8);
        expect(tjeldsundbrua?.windGust).toBeNull();
        // The mean is a separate measurement and is not suspect: it is
        // the gust the ratio test disbelieves.
        expect(tjeldsundbrua?.airTemperature).toBe(9.2);
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

/** One station's readings, for the wind cases that are easier to state directly than to encode in a fixture. */
function stationWeather(readings: { windSpeed?: number | null; windGust?: number | null }): RoadCameraSiteWeather | undefined {
    const features: RawFeature[] = [
        {
            geometry: { type: 'Point', coordinates: [16.1, 68.5] },
            properties: {
                REFERENCE_ID: '3000001',
                MEASUREMENT_TIME: '2026-09-13T20:30:00+02:00',
                AIR_TEMPERATURE: 9.2,
                ROAD_SURFACE_TEMPERATURE: 7.8,
                WIND_SPEED: readings.windSpeed ?? null,
                MAXIMUM_WIND_SPEED: readings.windGust ?? null,
                PRECIPITATION_INTENSITY: 0,
            },
        },
    ];
    return mapSiteWeather(features, new Set(['3000001']))['3000001'];
}

describe('mapSiteWeather -- what a wind reading has to be believed', () => {
    it(`refuses either reading above ${String(MAX_PLAUSIBLE_WIND_MPS)} m/s, whatever the other one says`, () => {
        // 62 against a 40 mean is a perfectly ordinary gust factor of
        // 1.55 -- and still past every wind speed ever recorded on the
        // Norwegian mainland, so the absolute cap fires on its own.
        expect(stationWeather({ windSpeed: 40, windGust: 62 })?.windGust).toBeNull();
        expect(stationWeather({ windSpeed: 40, windGust: 62 })?.windSpeed).toBe(40);
        expect(stationWeather({ windSpeed: 61, windGust: null })?.windSpeed).toBeNull();
    });

    it('keeps a real storm intact', () => {
        // 28 m/s mean with a 41 m/s gust is 1.5x: a severe gale off the
        // Vesterålen coast, and exactly the night this display exists
        // for. If a future tightening of the ratio breaks this, it should
        // break loudly.
        const storm = stationWeather({ windSpeed: 28, windGust: 41 });

        expect(storm?.windSpeed).toBe(28);
        expect(storm?.windGust).toBe(41);
    });

    it('keeps a gust from a station that reports no mean at all', () => {
        // Wind is null on roughly 200 of the 464 stations. With nothing
        // to take a ratio against, the gust keeps the absolute cap and
        // nothing more -- a missing mean is not evidence against it.
        expect(stationWeather({ windSpeed: null, windGust: 30 })?.windGust).toBe(30);
        expect(stationWeather({ windSpeed: null, windGust: 62 })?.windGust).toBeNull();
    });

    it('does not apply the ratio in near-calm air', () => {
        // 4 m/s off the fjord against a 0.5 m/s mean is an ordinary
        // afternoon, not a fault, and a ratio test at this resolution
        // measures rounding rather than wind. A mean of exactly zero is
        // the same case, and must not divide.
        expect(stationWeather({ windSpeed: 0.5, windGust: 4 })?.windGust).toBe(4);
        expect(stationWeather({ windSpeed: 0, windGust: 3 })?.windGust).toBe(3);
    });

    it(`applies the ratio once the mean is worth dividing by`, () => {
        // Just above the floor: 2 m/s mean, and the gust judged at 1.8x.
        expect(stationWeather({ windSpeed: 2, windGust: 3.5 })?.windGust).toBe(3.5);
        expect(stationWeather({ windSpeed: 2, windGust: 3.7 })?.windGust).toBeNull();
        expect(stationWeather({ windSpeed: 10, windGust: 18 })?.windGust).toBe(18);
        expect(stationWeather({ windSpeed: 10, windGust: 18.1 })?.windGust).toBeNull();
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
