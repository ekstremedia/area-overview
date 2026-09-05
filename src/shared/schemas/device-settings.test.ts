import { describe, expect, it } from 'vitest';
import { DeviceSettingsSchema } from './device-settings.js';

describe('DeviceSettingsSchema', () => {
    it('parses an empty object into a fully populated DeviceSettings', () => {
        expect(DeviceSettingsSchema.parse({})).toEqual({ theme: 'dark', fontScale: 1 });
    });

    it('rejects a fontScale outside its allowed range', () => {
        expect(DeviceSettingsSchema.safeParse({ fontScale: 2 }).success).toBe(false);
    });

    it('accepts a device settings object with an extra unknown field', () => {
        const result = DeviceSettingsSchema.safeParse({ unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });

    it('rejects an invalid theme value', () => {
        expect(DeviceSettingsSchema.safeParse({ theme: 'blue' }).success).toBe(false);
    });
});
