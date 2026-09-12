import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../../shared/result.js';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import type { SettingsStore } from '../../settings/sharedStore.js';
import { mount } from './Layers.js';
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

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: () => Promise.resolve({ configured: true, ships: [] }) }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Layers section', () => {
    it('renders one block per layer spec (ships, aircraft), each with an enabled toggle and two steppers', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const blocks = container.querySelectorAll('.settings-layer-block');
        expect(blocks).toHaveLength(2);
        expect(container.querySelectorAll('.toggle-row')).toHaveLength(3); // ships enabled + aircraft enabled + aircraft showOnGround
        expect(container.querySelectorAll('.stepper')).toHaveLength(4); // poll + max-age, x2 layers

        dispose();
    });

    it('aircraft gets a showOnGround toggle; ships does not', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const aircraftBlock = [...container.querySelectorAll('.settings-layer-block')][1];
        expect(aircraftBlock?.textContent).toContain('Vis fly på bakken');

        const shipsBlock = [...container.querySelectorAll('.settings-layer-block')][0];
        expect(shipsBlock?.textContent).not.toContain('Vis fly på bakken');

        dispose();
    });

    it('toggling ships.enabled writes immediately with the full ships object', () => {
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 15, maxAgeMinutes: 30 } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        container.querySelector<HTMLButtonElement>('.settings-layer-block .toggle')?.click();

        expect(patchSettings).toHaveBeenCalledWith({ ships: { enabled: false, pollSeconds: 15, maxAgeMinutes: 30 } });

        dispose();
    });

    it('shows the BarentsWatch-configured line for ships, derived from GET /api/ships', async () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        await vi.waitFor(() => {
            expect(container.querySelector('.settings-layer-credentials')?.textContent).toBe('BarentsWatch-nøkler er satt på serveren.');
        });

        dispose();
    });

    it('shows the BarentsWatch-missing line when /api/ships responds 503 {configured:false}', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503, ok: false, json: () => Promise.resolve({ configured: false }) }));
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        await vi.waitFor(() => {
            expect(container.querySelector('.settings-layer-credentials')?.textContent).toBe('BarentsWatch-nøkler er IKKE satt på serveren.');
        });

        dispose();
    });

    it('renders every control disabled when logged out', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        expect(container.querySelector<HTMLButtonElement>('.toggle')?.disabled).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('.stepper-button--increment')?.disabled).toBe(true);

        dispose();
    });
});
