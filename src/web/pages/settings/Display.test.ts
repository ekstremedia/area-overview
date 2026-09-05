import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../../shared/result.js';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { DeviceSettingsSchema } from '../../../shared/schemas/device-settings.js';
import { signal } from '../../core/signal.js';
import type { SettingsStore } from '../../settings/sharedStore.js';

const STORAGE_KEY = 'area-overview:device-settings';

function fakeStore(initial: Settings) {
    const settings = signal(initial);
    const patchSettings = vi.fn().mockImplementation((patch: Partial<Settings>) => {
        settings.set({ ...settings.get(), ...patch });
        return Promise.resolve(ok(settings.get()));
    });
    const store: SettingsStore = { settings, patchSettings, setPlacement: vi.fn(), dispose: vi.fn() };
    return { store, settings, patchSettings };
}

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.resetModules();
});

afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    document.body.innerHTML = '';
    vi.resetModules();
});

describe('Display section', () => {
    it('renders idle reset ("av" at 0), brightness, night schedule and device theme/font-scale controls', async () => {
        const { mount } = await import('./Display.js');
        const { store } = fakeStore(SettingsSchema.parse({ idleResetSeconds: 0, brightness: 80 }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const steppers = [...container.querySelectorAll('.stepper-value')];
        expect(steppers[0]?.textContent).toBe('av');
        expect(steppers[1]?.textContent).toBe('80 %');

        expect(container.querySelector('.time-field-input')).not.toBeNull();
        expect(container.querySelectorAll('.select-field').length).toBeGreaterThanOrEqual(2); // night mode + theme

        dispose();
    });

    it('toggling night.enabled writes the full night object immediately', async () => {
        const { mount } = await import('./Display.js');
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({ night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        container.querySelector<HTMLButtonElement>('.settings-night-row .toggle')?.click();

        expect(patchSettings).toHaveBeenCalledWith({ night: { enabled: true, from: '23:00', to: '06:00', mode: 'dim' } });

        dispose();
    });

    it('editing the night "from" TimeField flushes on blur with the composed night object', async () => {
        const { mount } = await import('./Display.js');
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({ night: { enabled: true, from: '23:00', to: '06:00', mode: 'dim' } }));
        const container = document.createElement('div');
        document.body.append(container);
        const dispose = mount(container, { store, loggedIn: true });

        const fromInput = container.querySelector<HTMLInputElement>('.time-field-input');
        if (!fromInput) throw new Error('time field input not found');
        fromInput.focus();
        fromInput.value = '22:30';
        fromInput.dispatchEvent(new Event('input', { bubbles: true }));
        fromInput.blur();

        expect(patchSettings).toHaveBeenCalledWith({ night: { enabled: true, from: '22:30', to: '06:00', mode: 'dim' } });

        dispose();
    });

    it('theme and font scale are editable even when logged out', async () => {
        const { mount } = await import('./Display.js');
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        const themeTiles = container.querySelectorAll<HTMLButtonElement>('.select-field-tile');
        // Night-mode tiles come first (disabled, logged out); theme tiles are the next group.
        const enabledTiles = [...themeTiles].filter((tile) => !tile.disabled);
        expect(enabledTiles.length).toBeGreaterThan(0);

        const fontScaleIncrement = [...container.querySelectorAll<HTMLButtonElement>('.stepper-button--increment')].at(-1);
        expect(fontScaleIncrement?.disabled).toBe(false);

        dispose();
    });

    it('changing theme persists to localStorage via setDeviceSettings', async () => {
        const { mount } = await import('./Display.js');
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const themeTiles = [...container.querySelectorAll<HTMLButtonElement>('.select-field-tile')];
        const lightTile = themeTiles.find((tile) => tile.textContent === 'Lys');
        lightTile?.click();

        const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
        expect(DeviceSettingsSchema.parse(stored).theme).toBe('light');

        dispose();
    });

    it('idle reset is disabled when logged out', async () => {
        const { mount } = await import('./Display.js');
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        expect(container.querySelector<HTMLButtonElement>('.stepper-button--increment')?.disabled).toBe(true);

        dispose();
    });
});
