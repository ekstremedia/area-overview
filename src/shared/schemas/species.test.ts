import { describe, expect, it } from 'vitest';
import { omitKey } from './test-utils.js';
import { SightingSchema, SpeciesResponseSchema } from './species.js';

const validSighting = {
    id: 'taxon:2492010:68.70:15.41',
    scientificName: 'Haliaeetus albicilla',
    vernacularName: 'Havørn',
    kingdom: 'Animalia',
    class: 'Aves',
    datasets: [{ key: '4bfac3ea-8763-4f4b-a71a-76a6f5f243d3', title: 'Artsobservasjoner' }],
    license: 'CC_BY_4_0',
    coordinateUncertaintyMeters: 50,
    count: 3,
    individualCount: 2,
    point: { lat: 68.6984, lng: 15.4129 },
    observedAt: '2026-08-30T10:00:00+02:00',
};

describe('SightingSchema', () => {
    it('parses a well-formed sighting', () => {
        expect(() => SightingSchema.parse(validSighting)).not.toThrow();
    });

    it('rejects a sighting missing the required kingdom field', () => {
        expect(SightingSchema.safeParse(omitKey(validSighting, 'kingdom')).success).toBe(false);
    });

    it('accepts an unfamiliar kingdom string, deliberately unlike a closed enum', () => {
        expect(SightingSchema.safeParse({ ...validSighting, kingdom: 'Chromista' }).success).toBe(true);
    });

    it('accepts a null vernacularName', () => {
        expect(SightingSchema.safeParse({ ...validSighting, vernacularName: null }).success).toBe(true);
    });

    it('rejects a count of zero, since a group folds together at least one record', () => {
        expect(SightingSchema.safeParse({ ...validSighting, count: 0 }).success).toBe(false);
    });

    it('rejects a non-integer count', () => {
        expect(SightingSchema.safeParse({ ...validSighting, count: 1.5 }).success).toBe(false);
    });

    it('accepts a null coordinateUncertaintyMeters and individualCount', () => {
        const result = SightingSchema.safeParse({ ...validSighting, coordinateUncertaintyMeters: null, individualCount: null });
        expect(result.success).toBe(true);
    });

    it('rejects a sighting missing datasets', () => {
        expect(SightingSchema.safeParse(omitKey(validSighting, 'datasets')).success).toBe(false);
    });

    it('rejects a sighting missing license', () => {
        expect(SightingSchema.safeParse(omitKey(validSighting, 'license')).success).toBe(false);
    });
});

describe('SpeciesResponseSchema', () => {
    it('accepts the configured:true shape with sightings', () => {
        const result = SpeciesResponseSchema.safeParse({
            configured: true,
            sightings: [validSighting],
            truncated: false,
            fetchedAt: '2026-08-30T10:00:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('accepts an empty sightings array', () => {
        const result = SpeciesResponseSchema.safeParse({
            configured: true,
            sightings: [],
            truncated: false,
            fetchedAt: '2026-08-30T10:00:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('accepts the configured:false shape', () => {
        expect(SpeciesResponseSchema.safeParse({ configured: false }).success).toBe(true);
    });

    it('rejects configured:true without sightings', () => {
        const result = SpeciesResponseSchema.safeParse({ configured: true, truncated: false, fetchedAt: '2026-08-30T10:00:00+02:00' });
        expect(result.success).toBe(false);
    });

    it('rejects configured:true without truncated', () => {
        const result = SpeciesResponseSchema.safeParse({ configured: true, sightings: [], fetchedAt: '2026-08-30T10:00:00+02:00' });
        expect(result.success).toBe(false);
    });

    it('rejects a fetchedAt that is not a parseable timestamp', () => {
        const result = SpeciesResponseSchema.safeParse({ configured: true, sightings: [], truncated: false, fetchedAt: 'nylig' });
        expect(result.success).toBe(false);
    });
});
