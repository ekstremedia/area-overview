import { describe, expect, it } from 'vitest';
import { RoadCameraSchema, RoadCameraSiteWeatherSchema, RoadCamerasResponseSchema } from './road-cameras.js';
import { omitKey } from './test-utils.js';

/** One of Hadselbrua's four orientations, as Vegvesen publishes it. */
const validCamera = {
    id: '3000957_1',
    siteId: '3000957',
    name: 'Hadselbrua',
    direction: 'mot Stokmarknes',
    roadNumber: 'E10',
    lat: 68.5561,
    lng: 14.9024,
    imageUrl: 'https://kamera.atlas.vegvesen.no/api/images/3000957_1',
};

const validWeather = {
    measuredAt: '2026-09-13T19:00:00+02:00',
    airTemperature: 7.2,
    roadTemperature: 9.1,
    windSpeed: 2.5,
    windGust: 4.4,
    precipitationIntensity: 0,
};

describe('RoadCameraSchema', () => {
    it('parses a well-formed road camera', () => {
        expect(() => RoadCameraSchema.parse(validCamera)).not.toThrow();
    });

    it('rejects a camera missing the required siteId, which is the weather join key', () => {
        expect(RoadCameraSchema.safeParse(omitKey(validCamera, 'siteId')).success).toBe(false);
    });

    it('accepts a camera with an extra unknown field', () => {
        expect(RoadCameraSchema.safeParse({ ...validCamera, unexpectedNewField: 'value' }).success).toBe(true);
    });

    it('accepts a null direction and roadNumber, both routinely absent', () => {
        expect(RoadCameraSchema.safeParse({ ...validCamera, direction: null, roadNumber: null }).success).toBe(true);
    });

    it('rejects an imageUrl that is not a URL at all', () => {
        // The host is asserted server-side as well; this is the shared
        // half of the guarantee that the app never hotlinks somewhere it
        // did not mean to.
        expect(RoadCameraSchema.safeParse({ ...validCamera, imageUrl: 'kamera.atlas.vegvesen.no/api/images/3000957_1' }).success).toBe(false);
        expect(RoadCameraSchema.safeParse({ ...validCamera, imageUrl: '' }).success).toBe(false);
    });

    it('rejects coordinates outside their ranges', () => {
        expect(RoadCameraSchema.safeParse({ ...validCamera, lat: 148.9 }).success).toBe(false);
        expect(RoadCameraSchema.safeParse({ ...validCamera, lng: 200 }).success).toBe(false);
    });
});

describe('RoadCameraSiteWeatherSchema', () => {
    it('parses a station reporting everything', () => {
        expect(() => RoadCameraSiteWeatherSchema.parse(validWeather)).not.toThrow();
    });

    it('accepts null for every reading, which is the norm rather than an error', () => {
        // Wind is missing on roughly 200 of 464 stations and road surface
        // temperature on 46; a null reading is omitted from the display,
        // so anything present is real.
        const result = RoadCameraSiteWeatherSchema.safeParse({
            measuredAt: validWeather.measuredAt,
            airTemperature: null,
            roadTemperature: null,
            windSpeed: null,
            windGust: null,
            precipitationIntensity: null,
        });
        expect(result.success).toBe(true);
    });

    it('accepts a sub-zero road surface temperature, the reading this exists for', () => {
        expect(RoadCameraSiteWeatherSchema.safeParse({ ...validWeather, roadTemperature: -3.4 }).success).toBe(true);
    });

    it('requires measuredAt, since a reading with no time is not carried at all', () => {
        expect(RoadCameraSiteWeatherSchema.safeParse(omitKey(validWeather, 'measuredAt')).success).toBe(false);
        expect(RoadCameraSiteWeatherSchema.safeParse({ ...validWeather, measuredAt: null }).success).toBe(false);
    });
});

describe('RoadCamerasResponseSchema', () => {
    it('parses cameras with their weather keyed by site id', () => {
        const result = RoadCamerasResponseSchema.safeParse({
            cameras: [validCamera, { ...validCamera, id: '3000957_2', direction: 'mot Melbu' }],
            weatherBySite: { '3000957': validWeather },
            fetchedAt: '2026-09-13T19:05:00+02:00',
        });

        expect(result.success).toBe(true);
        expect(result.data?.weatherBySite['3000957']).toEqual(validWeather);
    });

    it('parses an empty weatherBySite, since most sites have no co-located station', () => {
        const result = RoadCamerasResponseSchema.safeParse({
            cameras: [validCamera],
            weatherBySite: {},
            fetchedAt: '2026-09-13T19:05:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('parses an empty viewport with no cameras at all', () => {
        const result = RoadCamerasResponseSchema.safeParse({ cameras: [], weatherBySite: {}, fetchedAt: '2026-09-13T19:05:00+02:00' });
        expect(result.success).toBe(true);
    });

    it('carries no configured flag, because this upstream is keyless', () => {
        // Unlike ships, aircraft and road situations, there is no
        // unconfigured state to report here -- the layer's toggle lives
        // on the road-situations envelope.
        expect('configured' in RoadCamerasResponseSchema.shape).toBe(false);
    });

    it('rejects a weather entry that is not a valid reading', () => {
        const result = RoadCamerasResponseSchema.safeParse({
            cameras: [validCamera],
            weatherBySite: { '3000957': { airTemperature: 7.2 } },
            fetchedAt: '2026-09-13T19:05:00+02:00',
        });
        expect(result.success).toBe(false);
    });

    it('rejects a missing fetchedAt', () => {
        expect(RoadCamerasResponseSchema.safeParse({ cameras: [], weatherBySite: {} }).success).toBe(false);
    });
});
