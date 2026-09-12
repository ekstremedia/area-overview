import { describe, expect, it } from 'vitest';
import { OVERRIDABLE_FIELDS, PlacementSchema, SettingsOverrideSchema, SettingsPatchSchema, SettingsSchema } from './settings.js';

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

    /**
     * Regression test for a real bug: `SettingsSchema.omit(...).partial()`
     * looked correct but wasn't, because `.partial()` wraps each field's
     * *already-`.default()`-decorated* schema in `.optional()`, and in Zod
     * v4 that composition (`optional(default(base))`) still lets the
     * inner `.default()` fire for an absent key instead of leaving it
     * `undefined`. The observed symptom: `SettingsPatchSchema.parse({
     * brightness: 60 })` came back with all nine fields populated (each
     * omitted one backfilled with its schema default), not just
     * `brightness` -- silently turning every partial `PATCH` into a full
     * overwrite back to defaults for every field the caller didn't
     * mention. `SettingsPatchSchema` is now built from undecorated base
     * field schemas instead, specifically to keep this from recurring.
     */
    it('parses a single-key patch into an object with exactly that one key -- no other fields backfilled with their defaults', () => {
        const result = SettingsPatchSchema.parse({ brightness: 60 });

        expect(Object.keys(result)).toEqual(['brightness']);
        expect(result).toEqual({ brightness: 60 });
    });

    it('parses an empty patch into an empty object -- no keys at all', () => {
        const result = SettingsPatchSchema.parse({});

        expect(Object.keys(result)).toEqual([]);
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

describe('SettingsOverrideSchema', () => {
    it('keeps exactly the keys given, never backfilling defaults', () => {
        // The same `.partial()` trap `SettingsPatchSchema` documents: an
        // override object that quietly carries all eleven fields would
        // pin every setting on the device the moment one was changed.
        const parsed = SettingsOverrideSchema.parse({ brightness: 60 });

        expect(Object.keys(parsed)).toEqual(['brightness']);
    });

    it('parses an empty object to no overrides at all', () => {
        expect(SettingsOverrideSchema.parse({})).toEqual({});
    });

    it('validates a value exactly as a PATCH of the same field would', () => {
        expect(SettingsOverrideSchema.safeParse({ brightness: 5000 }).success).toBe(false);
        expect(SettingsOverrideSchema.safeParse({ homeView: { lat: 91, lng: 0, zoom: 11 } }).success).toBe(false);
        expect(SettingsOverrideSchema.safeParse({ language: 'klingon' }).success).toBe(false);
    });

    it('offers no override of camera placements, which are shared content rather than a preference', () => {
        expect('placements' in SettingsOverrideSchema.shape).toBe(false);
        // And an attempt to smuggle one through is dropped rather than honoured.
        expect(SettingsOverrideSchema.parse({ placements: { 'cam-1': { lat: 1, lng: 2 } } })).toEqual({});
    });

    it('offers no override of updatedAt, which the server sets', () => {
        expect('updatedAt' in SettingsOverrideSchema.shape).toBe(false);
    });

    it('covers every patchable field except the ones deliberately excluded', () => {
        expect(OVERRIDABLE_FIELDS.sort()).toEqual(Object.keys(SettingsPatchSchema.shape).sort());
    });
});
