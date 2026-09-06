import { describe, expect, it } from 'vitest';
import { ShipSchema, ShipsResponseSchema } from './ships.js';
import { omitKey } from './test-utils.js';

const validShip = {
    mmsi: '257123456',
    name: 'MS NORDLYS',
    lat: 68.6984,
    lng: 15.4129,
    speedOverGround: 12.3,
    courseOverGround: 270,
    heading: 268,
    shipType: 'passenger',
    navigationalStatus: 0,
    timestamp: '2026-09-05T01:00:00Z',
};

describe('ShipSchema', () => {
    it('parses a well-formed ship', () => {
        expect(() => ShipSchema.parse(validShip)).not.toThrow();
    });

    it('rejects a ship missing the required mmsi field', () => {
        const withoutMmsi = omitKey(validShip, 'mmsi');
        const result = ShipSchema.safeParse(withoutMmsi);
        expect(result.success).toBe(false);
    });

    it('accepts a ship with an extra unknown field', () => {
        const result = ShipSchema.safeParse({ ...validShip, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });

    it('accepts null heading and shipType', () => {
        const result = ShipSchema.safeParse({ ...validShip, heading: null, shipType: null });
        expect(result.success).toBe(true);
    });

    it('accepts a null navigationalStatus (defensive -- never actually observed null live)', () => {
        const result = ShipSchema.safeParse({ ...validShip, navigationalStatus: null });
        expect(result.success).toBe(true);
    });

    it('rejects a ship missing navigationalStatus entirely', () => {
        const withoutStatus = omitKey(validShip, 'navigationalStatus');
        const result = ShipSchema.safeParse(withoutStatus);
        expect(result.success).toBe(false);
    });
});

describe('ShipsResponseSchema', () => {
    it('accepts the configured:true shape with ships', () => {
        const result = ShipsResponseSchema.safeParse({
            configured: true,
            ships: [validShip],
            fetchedAt: '2026-09-05T01:00:00Z',
        });
        expect(result.success).toBe(true);
    });

    it('accepts the configured:false shape', () => {
        const result = ShipsResponseSchema.safeParse({ configured: false });
        expect(result.success).toBe(true);
    });

    it('rejects configured:true without ships', () => {
        const result = ShipsResponseSchema.safeParse({ configured: true, fetchedAt: '2026-09-05T01:00:00Z' });
        expect(result.success).toBe(false);
    });
});
