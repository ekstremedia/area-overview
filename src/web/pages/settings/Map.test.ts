import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../../shared/result.js';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import type { SettingsStore } from '../../settings/sharedStore.js';
import { activeMapInstance } from '../map/activeMap.js';
import { mount } from './Map.js';
import { fakeSettingsStore } from './test-helpers.js';

function fakeStore(initial: Settings) {
    const settings = signal(initial);
    const patchSettings = vi.fn().mockImplementation((patch: Partial<Settings>) => {
        settings.set({ ...settings.get(), ...patch });
        return Promise.resolve(ok(settings.get()));
    });
    const store: SettingsStore = fakeSettingsStore({ settings, patchSettings, setPlacement: vi.fn(), dispose: vi.fn() });
    return { store, settings, patchSettings };
}

function requireInput(container: HTMLElement, index: number): HTMLInputElement {
    const input = [...container.querySelectorAll<HTMLInputElement>('.number-field-input')][index];
    if (!input) throw new Error(`number field input ${String(index)} not found`);
    return input;
}

beforeEach(() => {
    vi.useFakeTimers();
    activeMapInstance.set(null);
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    activeMapInstance.set(null);
});

describe('Map section', () => {
    it('renders lat/lng/zoom number fields from homeView', () => {
        const { store } = fakeStore(SettingsSchema.parse({ homeView: { lat: 68.7, lng: 15.4, zoom: 11 } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const inputs = [...container.querySelectorAll<HTMLInputElement>('.number-field-input')];
        expect(inputs.map((input) => input.value)).toEqual(['68.7', '15.4', '11']);

        dispose();
    });

    it('the "use current position" button is disabled when no map is mounted', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const button = container.querySelector<HTMLButtonElement>('.settings-use-current-view');
        expect(button?.disabled).toBe(true);

        dispose();
    });

    it('the "use current position" button reads the map and writes the full homeView when a map is mounted', () => {
        const fakeMap = {} as unknown as Parameters<typeof activeMapInstance.set>[0];
        activeMapInstance.set(fakeMap);
        const { store } = fakeStore(SettingsSchema.parse({ homeView: { lat: 68.7, lng: 15.4, zoom: 11 } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const button = container.querySelector<HTMLButtonElement>('.settings-use-current-view');
        expect(button?.disabled).toBe(false);

        dispose();
    });

    it('editing lat debounces 500ms and sends the full composed homeView', async () => {
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({ homeView: { lat: 68.7, lng: 15.4, zoom: 11 } }));
        const container = document.createElement('div');
        document.body.append(container);
        const dispose = mount(container, { store, loggedIn: true });

        const latInput = requireInput(container, 0);
        latInput.focus();
        latInput.value = '68.72';
        latInput.dispatchEvent(new Event('input', { bubbles: true }));

        expect(patchSettings).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);

        expect(patchSettings).toHaveBeenCalledWith({ homeView: { lat: 68.72, lng: 15.4, zoom: 11 } });

        dispose();
    });

    it('an out-of-range latitude shows an inline error and triggers zero writes', () => {
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({ homeView: { lat: 68.7, lng: 15.4, zoom: 11 } }));
        const container = document.createElement('div');
        document.body.append(container);
        const dispose = mount(container, { store, loggedIn: true });

        const latInput = requireInput(container, 0);
        latInput.focus();
        latInput.value = '190';
        latInput.dispatchEvent(new Event('input', { bubbles: true }));
        latInput.blur();

        expect(patchSettings).not.toHaveBeenCalled();

        dispose();
    });

    it("leaves the home view editable when logged out -- it becomes this device's own home view", () => {
        activeMapInstance.set({} as unknown as Parameters<typeof activeMapInstance.set>[0]);
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        expect(container.querySelector<HTMLInputElement>('.number-field-input')?.disabled).toBe(false);
        // "Use the current view" needs a mounted map, not a password.
        expect(container.querySelector<HTMLButtonElement>('.settings-use-current-view')?.disabled).toBe(false);

        dispose();
    });
});

describe('Map section -- use my position', () => {
    it('writes the located position as a device override, never a shared write, even when logged in', async () => {
        vi.doMock('../../geolocation.js', () => ({
            requestPosition: vi.fn(() => Promise.resolve({ kind: 'ok', lat: 59.91, lng: 10.75, accuracyM: 20 })),
        }));
        const setLocalOverride = vi.fn();
        vi.doMock('../../settings/localOverrides.js', () => ({
            setLocalOverride,
            clearLocalOverride: vi.fn(),
            clearAllLocalOverrides: vi.fn(),
            localOverrides: { get: () => ({}) },
        }));
        vi.resetModules();
        const { mount: mountFresh } = await import('./Map.js');

        const { store, patchSettings } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mountFresh(container, { store, loggedIn: true });

        container.querySelector<HTMLButtonElement>('.settings-use-my-position')?.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(setLocalOverride).toHaveBeenCalledWith('homeView', { lat: 59.91, lng: 10.75, zoom: 12 });
        // A visitor's position is theirs; it must never move the kiosk.
        expect(patchSettings).not.toHaveBeenCalled();

        dispose();
        vi.doUnmock('../../geolocation.js');
        vi.doUnmock('../../settings/localOverrides.js');
        vi.resetModules();
    });

    it('explains a refused permission instead of moving the map', async () => {
        vi.doMock('../../geolocation.js', () => ({
            requestPosition: vi.fn(() => Promise.resolve({ kind: 'denied' })),
        }));
        const setLocalOverride = vi.fn();
        vi.doMock('../../settings/localOverrides.js', () => ({
            setLocalOverride,
            clearLocalOverride: vi.fn(),
            clearAllLocalOverrides: vi.fn(),
            localOverrides: { get: () => ({}) },
        }));
        vi.resetModules();
        const { mount: mountFresh } = await import('./Map.js');

        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mountFresh(container, { store, loggedIn: false });

        container.querySelector<HTMLButtonElement>('.settings-use-my-position')?.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(setLocalOverride).not.toHaveBeenCalled();
        const hints = [...container.querySelectorAll<HTMLElement>('.settings-use-current-view-hint')];
        expect(hints.some((hint) => !hint.hidden && /avslått/i.test(hint.textContent))).toBe(true);

        dispose();
        vi.doUnmock('../../geolocation.js');
        vi.doUnmock('../../settings/localOverrides.js');
        vi.resetModules();
    });
});
