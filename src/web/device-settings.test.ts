import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'area-overview:device-settings';

beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
});

afterEach(() => {
    localStorage.clear();
});

describe('deviceSettings', () => {
    it('falls back to schema defaults when nothing is stored', async () => {
        const { deviceSettings } = await import('./device-settings.js');
        expect(deviceSettings.get()).toEqual({ theme: 'dark', fontScale: 1 });
    });

    it('falls back to schema defaults on corrupt JSON, without throwing', async () => {
        localStorage.setItem(STORAGE_KEY, '{not json');
        const { deviceSettings } = await import('./device-settings.js');
        expect(deviceSettings.get()).toEqual({ theme: 'dark', fontScale: 1 });
    });

    it('falls back to schema defaults on a value that fails schema validation', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'ultraviolet', fontScale: 99 }));
        const { deviceSettings } = await import('./device-settings.js');
        expect(deviceSettings.get()).toEqual({ theme: 'dark', fontScale: 1 });
    });

    it('reads back a previously stored valid value', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'light', fontScale: 1.3 }));
        const { deviceSettings } = await import('./device-settings.js');
        expect(deviceSettings.get()).toEqual({ theme: 'light', fontScale: 1.3 });
    });
});

describe('setDeviceSettings', () => {
    it('merges a partial patch, validates it, updates the signal and persists it', async () => {
        const { deviceSettings, setDeviceSettings } = await import('./device-settings.js');

        setDeviceSettings({ theme: 'light' });
        expect(deviceSettings.get()).toEqual({ theme: 'light', fontScale: 1 });

        setDeviceSettings({ fontScale: 1.4 });
        expect(deviceSettings.get()).toEqual({ theme: 'light', fontScale: 1.4 });

        const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
        expect(stored).toEqual({ theme: 'light', fontScale: 1.4 });
    });

    it('throws on a patch that fails schema validation, leaving the signal unchanged', async () => {
        const { deviceSettings, setDeviceSettings } = await import('./device-settings.js');
        expect(() => {
            setDeviceSettings({ fontScale: 99 });
        }).toThrow();
        expect(deviceSettings.get()).toEqual({ theme: 'dark', fontScale: 1 });
    });
});
