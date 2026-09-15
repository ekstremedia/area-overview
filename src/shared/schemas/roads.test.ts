import { describe, expect, it } from 'vitest';
import { RoadSituationSchema, RoadSituationsResponseSchema } from './roads.js';
import { omitKey } from './test-utils.js';

/**
 * Modelled on a real Vesterålen record: roadworks on Sortlandsbrua with
 * validity periods, upstream's `|` line breaks already turned into `\n`
 * by the server-side mapper.
 */
const validSituation = {
    id: 'NPRA_NO_SITUATION_123456',
    kind: 'roadworks',
    rawType: 'MaintenanceWorks',
    severity: 'low',
    status: 'current',
    closed: false,
    effects: ['laneClosures', 'temporaryTrafficLights'],
    roadNumber: 'E10',
    location: 'Sortlandsbrua',
    description: 'Vegarbeid\nKolonnekjøring 08:00-21:00.',
    startsAt: '2026-09-13T08:00:00+02:00',
    endsAt: '2026-09-20T21:00:00+02:00',
    updatedAt: '2026-09-13T19:05:00+02:00',
    periodic: true,
    point: { lat: 68.6984, lng: 15.4129 },
    line: null,
};

describe('RoadSituationSchema', () => {
    it('parses a well-formed road situation', () => {
        expect(() => RoadSituationSchema.parse(validSituation)).not.toThrow();
    });

    it('rejects a situation missing the required id field', () => {
        const withoutId = omitKey(validSituation, 'id');
        expect(RoadSituationSchema.safeParse(withoutId).success).toBe(false);
    });

    it('accepts a situation with an extra unknown field', () => {
        const result = RoadSituationSchema.safeParse({ ...validSituation, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });

    it('accepts a null endsAt, which is how upstream says "inntil videre"', () => {
        const result = RoadSituationSchema.safeParse({ ...validSituation, endsAt: null });
        expect(result.success).toBe(true);
    });

    it('rejects a null startsAt, which upstream never sends', () => {
        expect(RoadSituationSchema.safeParse({ ...validSituation, startsAt: null }).success).toBe(false);
    });

    it('accepts null roadNumber and location, both genuinely absent on some records', () => {
        const result = RoadSituationSchema.safeParse({ ...validSituation, roadNumber: null, location: null });
        expect(result.success).toBe(true);
    });

    it('accepts an empty effects array, for a situation with no consequence records', () => {
        expect(RoadSituationSchema.safeParse({ ...validSituation, effects: [] }).success).toBe(true);
    });

    it('rejects a kind outside the known set, so an unmapped upstream type cannot reach the map', () => {
        expect(RoadSituationSchema.safeParse({ ...validSituation, kind: 'MaintenanceWorks' }).success).toBe(false);
    });

    it('accepts an unfamiliar severity string, deliberately unlike kind', () => {
        // The asymmetry is the point: `kind` picks a sign face and must be
        // closed, while `severity` is passed through for display, so a
        // value Vegvesen adds later must not fail an otherwise-good
        // response.
        expect(RoadSituationSchema.safeParse({ ...validSituation, severity: 'catastrophic' }).success).toBe(true);
    });

    it('rejects a status of expired, which is dropped server-side and never reaches a client', () => {
        expect(RoadSituationSchema.safeParse({ ...validSituation, status: 'expired' }).success).toBe(false);
    });

    it('accepts the scheduled and planned statuses the client filters on', () => {
        expect(RoadSituationSchema.safeParse({ ...validSituation, status: 'scheduled' }).success).toBe(true);
        expect(RoadSituationSchema.safeParse({ ...validSituation, status: 'planned' }).success).toBe(true);
    });
});

describe("RoadSituationSchema's geometry", () => {
    it('accepts a null line, which is what a pin-only situation such as a wind warning carries', () => {
        expect(RoadSituationSchema.safeParse({ ...validSituation, line: null }).success).toBe(true);
    });

    it('accepts several lines, as a MultiLineString closure yields', () => {
        const result = RoadSituationSchema.safeParse({
            ...validSituation,
            closed: true,
            line: [
                [
                    [68.7, 15.4],
                    [68.71, 15.41],
                ],
                [
                    [68.72, 15.43],
                    [68.73, 15.44],
                ],
            ],
        });
        expect(result.success).toBe(true);
    });

    /**
     * The one guard that catches a mapper forgetting to swap upstream's
     * coordinate order. The WFS emits `[lng, lat]`; this schema carries
     * `[lat, lng]` (Leaflet's own tuple order). Vesterålen's longitudes
     * are around 15 and its latitudes around 68, so a forgotten swap
     * anywhere else in Norway is not caught by range alone -- but a
     * latitude past ±90 can only be a longitude, and that is the failure
     * this pins.
     */
    it('rejects a pair whose first number is out of latitude range -- an un-swapped [lng, lat] from upstream', () => {
        const result = RoadSituationSchema.safeParse({
            ...validSituation,
            line: [
                [
                    [150.4, 68.7],
                    [150.41, 68.71],
                ],
            ],
        });
        expect(result.success).toBe(false);
    });

    it('rejects a coordinate pair with a third element', () => {
        const result = RoadSituationSchema.safeParse({ ...validSituation, line: [[[68.7, 15.4, 12]]] });
        expect(result.success).toBe(false);
    });

    it('rejects a point whose lat and lng are swapped', () => {
        expect(RoadSituationSchema.safeParse({ ...validSituation, point: { lat: 154.12, lng: 68.69 } }).success).toBe(false);
    });
});

describe('RoadSituationsResponseSchema', () => {
    it('accepts the configured:true shape with situations', () => {
        const result = RoadSituationsResponseSchema.safeParse({
            configured: true,
            situations: [validSituation],
            fetchedAt: '2026-09-13T19:05:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('accepts an empty situations array, the common answer for a quiet viewport', () => {
        const result = RoadSituationsResponseSchema.safeParse({
            configured: true,
            situations: [],
            fetchedAt: '2026-09-13T19:05:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('accepts the configured:false shape', () => {
        // Never sent in practice -- Vegvesen's GeoServer needs no
        // credentials -- but the envelope matches ships and aircraft so
        // every live layer reads the same way on both sides of the wire.
        expect(RoadSituationsResponseSchema.safeParse({ configured: false }).success).toBe(true);
    });

    it('rejects configured:true without situations', () => {
        const result = RoadSituationsResponseSchema.safeParse({ configured: true, fetchedAt: '2026-09-13T19:05:00+02:00' });
        expect(result.success).toBe(false);
    });

    it('rejects a fetchedAt that is not a parseable timestamp', () => {
        const result = RoadSituationsResponseSchema.safeParse({ configured: true, situations: [], fetchedAt: 'nylig' });
        expect(result.success).toBe(false);
    });
});
