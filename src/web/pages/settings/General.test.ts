import { describe, expect, it, vi } from 'vitest';
import { ok } from '../../../shared/result.js';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import type { SettingsStore } from '../../settings/sharedStore.js';
import { mount } from './General.js';
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

describe('General section', () => {
    it('renders the poll interval, language and page toggles from the store', () => {
        const { store } = fakeStore(SettingsSchema.parse({ pollIntervalSeconds: 60, language: 'nb' }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        expect(container.querySelector('.stepper-value')?.textContent).toBe('60 s');
        expect(container.querySelectorAll('.toggle-row')).toHaveLength(5);

        dispose();
    });

    it('changing the poll interval writes immediately, once, with no debounce', () => {
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({ pollIntervalSeconds: 60 }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        container.querySelector<HTMLButtonElement>('.stepper-button--increment')?.click();

        expect(patchSettings).toHaveBeenCalledTimes(1);
        expect(patchSettings).toHaveBeenCalledWith({ pollIntervalSeconds: 70 });

        dispose();
    });

    it('toggling a page off removes it from enabledPages; toggling it back on adds it back', () => {
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const toggles = [...container.querySelectorAll<HTMLButtonElement>('.toggle')];
        toggles[1]?.click(); // weather

        expect(patchSettings).toHaveBeenLastCalledWith({ enabledPages: ['map', 'aurora', 'tide', 'cameras'] });

        toggles[1]?.click();
        expect(patchSettings).toHaveBeenLastCalledWith({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });

        dispose();
    });

    it('renders every control disabled when logged out', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        expect(container.querySelector<HTMLButtonElement>('.stepper-button--increment')?.disabled).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('.select-field-tile')?.disabled).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('.toggle')?.disabled).toBe(true);

        dispose();
    });

    it('updates the displayed poll interval when the store value changes externally (e.g. a poll)', () => {
        const { store, settings } = fakeStore(SettingsSchema.parse({ pollIntervalSeconds: 60 }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        settings.set({ ...settings.get(), pollIntervalSeconds: 120 });

        expect(container.querySelector('.stepper-value')?.textContent).toBe('120 s');

        dispose();
    });
});
