import { describe, expect, it } from 'vitest';
import { omitKey } from './test-utils.js';
import { TransitResponseSchema, TransitVehicleSchema } from './transit.js';

const validVehicle = {
    id: 'VEH:123',
    mode: 'bus',
    line: '900',
    publicCode: '754',
    operatorRef: 'VNK:Operator:VNK',
    origin: 'Sortland',
    destination: 'Andenes',
    delaySeconds: 120,
    point: { lat: 68.6984, lng: 15.4129 },
    recordedAt: '2026-09-13T19:05:00+02:00',
};

describe('TransitVehicleSchema', () => {
    it('parses a well-formed vehicle', () => {
        expect(() => TransitVehicleSchema.parse(validVehicle)).not.toThrow();
    });

    it('rejects a vehicle missing the required id field', () => {
        const withoutId = omitKey(validVehicle, 'id');
        expect(TransitVehicleSchema.safeParse(withoutId).success).toBe(false);
    });

    it('accepts the ferry mode', () => {
        expect(TransitVehicleSchema.safeParse({ ...validVehicle, mode: 'ferry' }).success).toBe(true);
    });

    it('rejects a mode outside the closed bus/ferry set', () => {
        expect(TransitVehicleSchema.safeParse({ ...validVehicle, mode: 'rail' }).success).toBe(false);
    });

    it('accepts a null line, publicCode, operatorRef, origin, destination and delaySeconds', () => {
        const result = TransitVehicleSchema.safeParse({
            ...validVehicle,
            line: null,
            publicCode: null,
            operatorRef: null,
            origin: null,
            destination: null,
            delaySeconds: null,
        });
        expect(result.success).toBe(true);
    });

    it('accepts a negative delaySeconds, which means running early', () => {
        expect(TransitVehicleSchema.safeParse({ ...validVehicle, delaySeconds: -60 }).success).toBe(true);
    });
});

describe('TransitResponseSchema', () => {
    it('accepts the configured:true shape with vehicles', () => {
        const result = TransitResponseSchema.safeParse({
            configured: true,
            vehicles: [validVehicle],
            fetchedAt: '2026-09-13T19:05:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('accepts an empty vehicles array', () => {
        const result = TransitResponseSchema.safeParse({ configured: true, vehicles: [], fetchedAt: '2026-09-13T19:05:00+02:00' });
        expect(result.success).toBe(true);
    });

    it('accepts the configured:false shape', () => {
        expect(TransitResponseSchema.safeParse({ configured: false }).success).toBe(true);
    });

    it('rejects configured:true without vehicles', () => {
        const result = TransitResponseSchema.safeParse({ configured: true, fetchedAt: '2026-09-13T19:05:00+02:00' });
        expect(result.success).toBe(false);
    });

    it('rejects a fetchedAt that is not a parseable timestamp', () => {
        const result = TransitResponseSchema.safeParse({ configured: true, vehicles: [], fetchedAt: 'nylig' });
        expect(result.success).toBe(false);
    });
});
