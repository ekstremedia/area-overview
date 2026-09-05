import { describe, expect, it } from 'vitest';
import { PlacementSchema, SettingsPatchSchema, SettingsSchema } from './settings.js';

describe('SettingsSchema', () => {
    it('parses an empty object into a fully populated Settings, using only schema defaults', () => {
        const parsed = SettingsSchema.parse({});

        expect(parsed).toMatchObject({
            language: 'nb',
            homeView: { lat: 68.6984, lng: 15.4129, zoom: 11 },
            placements: {},
            pollIntervalSeconds: 30,
            enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'],
            idleResetSeconds: 300,
            night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' },
            brightness: 100,
            ships: { enabled: true, pollSeconds: 15, maxAgeMinutes: 30 },
            aircraft: { enabled: true, pollSeconds: 10, maxAgeMinutes: 10, showOnGround: false },
        });
        expect(typeof parsed.updatedAt).toBe('string');
    });

    it('rejects an invalid pollIntervalSeconds outside its allowed range', () => {
        const result = SettingsSchema.safeParse({ pollIntervalSeconds: 5 });
        expect(result.success).toBe(false);
    });

    it('accepts a settings object with an extra unknown field', () => {
        const result = SettingsSchema.safeParse({ unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });

    it('accepts a real placements record keyed by camera_id', () => {
        const result = SettingsSchema.safeParse({
            placements: { spjutvika_01: { lat: 68.7, lng: 15.5 } },
        });
        expect(result.success).toBe(true);
    });
});

describe('SettingsPatchSchema', () => {
    it('accepts a partial patch touching a single key', () => {
        const result = SettingsPatchSchema.safeParse({ brightness: 60 });
        expect(result.success).toBe(true);
    });

    it('accepts an empty patch', () => {
        expect(SettingsPatchSchema.safeParse({}).success).toBe(true);
    });

    it('strips placements out of a patch, since it is excluded from the patch schema', () => {
        const result = SettingsPatchSchema.safeParse({ brightness: 60, placements: { a: { lat: 0, lng: 0 } } });
        expect(result.success).toBe(true);
        expect(result.data).not.toHaveProperty('placements');
    });

    it('strips updatedAt out of a patch, since it is server-set', () => {
        const result = SettingsPatchSchema.safeParse({ brightness: 60, updatedAt: '2026-09-05T00:00:00Z' });
        expect(result.success).toBe(true);
        expect(result.data).not.toHaveProperty('updatedAt');
    });
});

describe('PlacementSchema', () => {
    it('parses a valid placement', () => {
        expect(PlacementSchema.safeParse({ lat: 68.7, lng: 15.5 }).success).toBe(true);
    });

    it('rejects a placement missing lat', () => {
        expect(PlacementSchema.safeParse({ lng: 15.5 }).success).toBe(false);
    });
});
