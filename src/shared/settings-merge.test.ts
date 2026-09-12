import { describe, expect, it } from 'vitest';
import { SettingsSchema, type Settings } from './schemas/settings.js';
import { mergeSettings, overriddenFields } from './settings-merge.js';

const base: Settings = SettingsSchema.parse({});

describe('mergeSettings', () => {
    it('is the shared settings untouched when the device has overridden nothing', () => {
        expect(mergeSettings(base, {})).toEqual(base);
    });

    it('replaces only the overridden field, leaving every other one identical', () => {
        const merged = mergeSettings(base, { brightness: 40 });

        expect(merged.brightness).toBe(40);
        expect({ ...merged, brightness: base.brightness }).toEqual(base);
    });

    it('replaces a compound field whole, never merging it leaf by leaf', () => {
        const merged = mergeSettings(base, { homeView: { lat: 59.91, lng: 10.75, zoom: 12 } });

        expect(merged.homeView).toEqual({ lat: 59.91, lng: 10.75, zoom: 12 });
    });

    it('mutates neither argument', () => {
        const overrides = { brightness: 40 };
        mergeSettings(base, overrides);

        expect(base.brightness).toBe(100);
        expect(overrides).toEqual({ brightness: 40 });
    });

    it('ignores a key present but undefined, rather than blanking the shared value', () => {
        // What a half-cleared field looks like in flight. Spreading it
        // straight over `base` would replace a real setting with nothing.
        const merged = mergeSettings(base, { brightness: undefined });

        expect(merged.brightness).toBe(100);
    });

    it('applies several overrides at once', () => {
        const merged = mergeSettings(base, { brightness: 40, language: 'en', idleResetSeconds: 0 });

        expect(merged.brightness).toBe(40);
        expect(merged.language).toBe('en');
        expect(merged.idleResetSeconds).toBe(0);
    });

    it('leaves fields a device may never override coming from the shared value', () => {
        const withPlacement = SettingsSchema.parse({ placements: { 'cam-1': { lat: 68.7, lng: 15.4 } } });

        const merged = mergeSettings(withPlacement, { brightness: 40 });

        expect(merged.placements).toEqual({ 'cam-1': { lat: 68.7, lng: 15.4 } });
    });
});

describe('overriddenFields', () => {
    it('is empty for a device following the shared settings', () => {
        expect(overriddenFields({})).toEqual([]);
    });

    it('names exactly the fields the device has taken over', () => {
        expect(overriddenFields({ brightness: 40, language: 'en' }).sort()).toEqual(['brightness', 'language']);
    });

    it('does not count a key present but undefined', () => {
        expect(overriddenFields({ brightness: undefined })).toEqual([]);
    });
});
