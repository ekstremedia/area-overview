import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import { DeviceSettingsSchema, type DeviceSettings } from '../../shared/schemas/device-settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const mockDeviceSettings = signal<DeviceSettings>(DeviceSettingsSchema.parse({}));
vi.mock('../device-settings.js', () => ({ deviceSettings: mockDeviceSettings }));

const { startFontScaleApplication, startThemeApplication } = await import('./theme.js');

function setSettings(patch: Partial<Settings>): void {
    mockSettings.set({ ...mockSettings.get(), ...patch });
}

function setDeviceSettings(patch: Partial<DeviceSettings>): void {
    mockDeviceSettings.set({ ...mockDeviceSettings.get(), ...patch });
}

function mockMatchMedia(matches: boolean): { mql: MediaQueryList; fire: (next: boolean) => void } {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    let current = matches;
    const mql = {
        get matches() {
            return current;
        },
        media: '(prefers-color-scheme: light)',
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
            listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
            listeners.delete(listener);
        },
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql);
    return {
        mql,
        fire: (next: boolean) => {
            current = next;
            for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    setSettings({ night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' } });
    setDeviceSettings({ theme: 'dark', fontScale: 1 });
});

describe('startThemeApplication', () => {
    it('applies the device theme directly for dark/light', () => {
        mockMatchMedia(false);
        const root = document.createElement('html');
        setDeviceSettings({ theme: 'light' });
        const dispose = startThemeApplication(root);

        expect(root.getAttribute('data-theme')).toBe('light');

        setDeviceSettings({ theme: 'dark' });
        expect(root.getAttribute('data-theme')).toBe('dark');

        dispose();
    });

    it("resolves 'system' from prefers-color-scheme, and reacts live to a change", () => {
        const { fire } = mockMatchMedia(true); // starts preferring light
        const root = document.createElement('html');
        setDeviceSettings({ theme: 'system' });
        const dispose = startThemeApplication(root);

        expect(root.getAttribute('data-theme')).toBe('light');

        fire(false); // system now prefers dark
        expect(root.getAttribute('data-theme')).toBe('dark');

        dispose();
    });

    it("forces dark during an active night-schedule 'dark' window, regardless of device theme", () => {
        mockMatchMedia(false);
        const root = document.createElement('html');
        setDeviceSettings({ theme: 'light' });
        const now = new Date();
        const from = `${String(now.getHours()).padStart(2, '0')}:00`;
        const to = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
        const dispose = startThemeApplication(root);

        expect(root.getAttribute('data-theme')).toBe('light');

        setSettings({ night: { enabled: true, from, to, mode: 'dark' } });
        expect(root.getAttribute('data-theme')).toBe('dark');

        dispose();
    });
});

describe('startFontScaleApplication', () => {
    it('sets --font-scale-multiplier from deviceSettings.fontScale, reactively', () => {
        const root = document.createElement('html');
        setDeviceSettings({ fontScale: 1 });
        const dispose = startFontScaleApplication(root);

        expect(root.style.getPropertyValue('--font-scale-multiplier')).toBe('1');

        setDeviceSettings({ fontScale: 1.4 });
        expect(root.style.getPropertyValue('--font-scale-multiplier')).toBe('1.4');

        dispose();
    });
});
