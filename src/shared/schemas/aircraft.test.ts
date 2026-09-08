import { describe, expect, it } from 'vitest';
import { AircraftSchema, AircraftResponseSchema } from './aircraft.js';
import { omitKey } from './test-utils.js';

const validAircraft = {
    icao: '4CA1B2',
    callsign: 'SAS123',
    lat: 68.6984,
    lng: 15.4129,
    altitudeFt: 32000,
    groundSpeedKt: 450,
    track: 90,
    timestamp: '2026-09-05T01:00:00Z',
};

describe('AircraftSchema', () => {
    it('parses a well-formed airborne aircraft', () => {
        expect(() => AircraftSchema.parse(validAircraft)).not.toThrow();
    });

    it("accepts 'ground' as the altitude for a grounded aircraft", () => {
        const result = AircraftSchema.safeParse({ ...validAircraft, altitudeFt: 'ground' });
        expect(result.success).toBe(true);
    });

    it('rejects an aircraft missing the required icao field', () => {
        const withoutIcao = omitKey(validAircraft, 'icao');
        const result = AircraftSchema.safeParse(withoutIcao);
        expect(result.success).toBe(false);
    });

    it('accepts an aircraft with an extra unknown field', () => {
        const result = AircraftSchema.safeParse({ ...validAircraft, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });

    it('rejects an arbitrary string altitude other than ground', () => {
        const result = AircraftSchema.safeParse({ ...validAircraft, altitudeFt: 'flying' });
        expect(result.success).toBe(false);
    });
});

describe('AircraftResponseSchema', () => {
    it('accepts the configured:true shape with aircraft', () => {
        const result = AircraftResponseSchema.safeParse({
            configured: true,
            aircraft: [validAircraft],
            fetchedAt: '2026-09-05T01:00:00Z',
        });
        expect(result.success).toBe(true);
    });

    it('accepts the configured:false shape', () => {
        const result = AircraftResponseSchema.safeParse({ configured: false });
        expect(result.success).toBe(true);
    });

    it('accepts a configured:true shape with sources', () => {
        const result = AircraftResponseSchema.safeParse({
            configured: true,
            aircraft: [validAircraft],
            fetchedAt: '2026-09-05T01:00:00Z',
            sources: ['adsbfi', 'opensky'],
        });
        expect(result.success).toBe(true);
    });

    it('rejects a source outside the known provider set', () => {
        const result = AircraftResponseSchema.safeParse({
            configured: true,
            aircraft: [validAircraft],
            fetchedAt: '2026-09-05T01:00:00Z',
            sources: ['not-a-real-provider'],
        });
        expect(result.success).toBe(false);
    });
});
