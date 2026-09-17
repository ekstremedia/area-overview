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
    it('renders one block per layer spec (ships, aircraft, roads, transit, warnings, species), each with an enabled toggle and its own steppers', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const blocks = container.querySelectorAll('.settings-layer-block');
        expect(blocks).toHaveLength(6);
        // ships enabled + aircraft enabled + aircraft showOnGround + roads
        // enabled + roads showPlanned + roads showCameras + transit enabled +
        // transit showBuses + transit showFerries + warnings enabled +
        // warnings showAvalanche + species enabled + species animalsOnly.
        expect(container.querySelectorAll('.toggle-row')).toHaveLength(13);
        // poll + max-age for ships, aircraft and transit; poll alone for
        // roads, warnings and species.
        expect(container.querySelectorAll('.stepper')).toHaveLength(9);
        // Species' own day-window control -- a segmented `selectField`,
        // not a stepper (see `Layers.ts`'s own comment on why).
        expect(container.querySelectorAll('.select-field')).toHaveLength(1);

        dispose();
    });

    it('renders no max-age stepper for roads: a road notice has a validity window, not a fix age', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const [shipsBlock, aircraftBlock, roadsBlock] = [...container.querySelectorAll('.settings-layer-block')];
        expect(shipsBlock?.textContent).toContain('Maks alder');
        expect(aircraftBlock?.textContent).toContain('Maks alder');
        expect(roadsBlock?.textContent).not.toContain('Maks alder');
        // The poll stepper is still there -- only the max-age row is
        // conditional, and it is conditional on the *spec* (`ROADS_LAYER`
        // sets neither `maxAgeMinutesMin` nor `maxAgeMinutesMax`), not on
        // the layer's id.
        expect(roadsBlock?.querySelectorAll('.stepper')).toHaveLength(1);
        expect(roadsBlock?.textContent).toContain('Oppdateringsintervall');

        dispose();
    });

    it('gives roads its two own filters, and no other layer them', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const [shipsBlock, , roadsBlock] = [...container.querySelectorAll('.settings-layer-block')];
        expect(roadsBlock?.textContent).toContain('Vis planlagt vegarbeid');
        expect(roadsBlock?.textContent).toContain('Vis vegkamera');
        expect(shipsBlock?.textContent).not.toContain('Vis planlagt vegarbeid');
        expect(roadsBlock?.textContent).not.toContain('Vis fly på bakken');

        dispose();
    });

    it('toggling roads.showPlanned writes the whole roads object, like every other layer field', () => {
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const roadsBlock = [...container.querySelectorAll('.settings-layer-block')][2];
        // [0] is the block's enabled toggle in the heading row; [1] is
        // showPlanned, [2] showCameras.
        [...(roadsBlock?.querySelectorAll<HTMLButtonElement>('.toggle') ?? [])][1]?.click();

        expect(patchSettings).toHaveBeenCalledWith({ roads: { enabled: true, pollSeconds: 120, showPlanned: true, showCameras: true } });

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

    it('gives species its own animalsOnly toggle and a 4-bucket day-window select, and no other layer them', () => {
        const { store, patchSettings } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const blocks = [...container.querySelectorAll('.settings-layer-block')];
        const speciesBlock = blocks[5];
        expect(speciesBlock?.textContent).toContain('Bare dyr');
        expect(speciesBlock?.textContent).toContain('Siste 30 dager');
        expect(blocks[0]?.textContent).not.toContain('Bare dyr');

        // The day-window tiles state every bucket in days, never as a live
        // control -- the plan's own settled requirement.
        const tiles = [...(speciesBlock?.querySelectorAll<HTMLButtonElement>('.select-field-tile') ?? [])];
        expect(tiles.map((tile) => tile.textContent)).toEqual(['Siste 7 dager', 'Siste 30 dager', 'Siste 90 dager', 'Siste 365 dager']);

        tiles[2]?.click();
        expect(patchSettings).toHaveBeenCalledWith({ species: { enabled: true, pollSeconds: 3600, days: 90, animalsOnly: false } });

        dispose();
    });

    it('leaves every control editable when logged out -- the edit lands on this device instead', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        expect(container.querySelector<HTMLButtonElement>('.toggle')?.disabled).toBe(false);
        expect(container.querySelector<HTMLButtonElement>('.stepper-button--increment')?.disabled).toBe(false);

        dispose();
    });
});
