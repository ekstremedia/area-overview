import { describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import { IDLE_RESET_EVENT } from '../../shell/idle.js';
import { applyHomeView, readCurrentView, startHomeViewSync } from './homeView.js';

function settingsWith(homeView: Settings['homeView']) {
    return signal<Settings>(SettingsSchema.parse({ homeView }));
}

function fakeMap(): { map: Leaflet.Map; setView: ReturnType<typeof vi.fn> } {
    const setView = vi.fn();
    const map = {
        setView,
        getCenter: () => ({ lat: 68.1, lng: 15.1 }),
        getZoom: () => 12,
    } as unknown as Leaflet.Map;
    return { map, setView };
}

describe('applyHomeView', () => {
    it("calls map.setView with the home view's [lat, lng] and zoom", () => {
        const { map, setView } = fakeMap();

        applyHomeView(map, { lat: 68.72, lng: 15.42, zoom: 13 });

        expect(setView).toHaveBeenCalledWith([68.72, 15.42], 13);
    });
});

describe('readCurrentView', () => {
    it("reads the map's current center/zoom back out in Settings['homeView'] shape", () => {
        const { map } = fakeMap();

        expect(readCurrentView(map)).toEqual({ lat: 68.1, lng: 15.1, zoom: 12 });
    });
});

describe('startHomeViewSync', () => {
    it('applies the stored home view once, immediately on start', () => {
        const { map, setView } = fakeMap();
        const settings = settingsWith({ lat: 68.72, lng: 15.42, zoom: 13 });

        const dispose = startHomeViewSync(map, { settings, target: new EventTarget() });

        expect(setView).toHaveBeenCalledTimes(1);
        expect(setView).toHaveBeenCalledWith([68.72, 15.42], 13);

        dispose();
    });

    it('re-applies the (possibly changed) home view when IDLE_RESET_EVENT fires', () => {
        const { map, setView } = fakeMap();
        const settings = settingsWith({ lat: 68.72, lng: 15.42, zoom: 13 });
        const target = new EventTarget();

        const dispose = startHomeViewSync(map, { settings, target });
        expect(setView).toHaveBeenCalledTimes(1);

        // The home view changed (e.g. Phase 9's settings UI) since mount --
        // the idle-reset re-reads `settings` at fire time, not a value
        // captured at mount.
        settings.set({ ...settings.get(), homeView: { lat: 69.0, lng: 16.0, zoom: 10 } });
        target.dispatchEvent(new CustomEvent(IDLE_RESET_EVENT));

        expect(setView).toHaveBeenCalledTimes(2);
        expect(setView).toHaveBeenNthCalledWith(2, [69.0, 16.0], 10);

        dispose();
    });

    it('does NOT re-apply the home view on an unrelated settings poll (only on mount and on idle-reset)', () => {
        const { map, setView } = fakeMap();
        const settings = settingsWith({ lat: 68.72, lng: 15.42, zoom: 13 });
        const target = new EventTarget();

        const dispose = startHomeViewSync(map, { settings, target });
        expect(setView).toHaveBeenCalledTimes(1);

        // A settings poll landing with an unrelated field changed (or even
        // the same homeView re-sent) must not re-center a map the user might
        // currently be panning.
        settings.set({ ...settings.get(), brightness: 42 });
        settings.set({ ...settings.get(), homeView: { lat: 99, lng: 99, zoom: 5 } });

        expect(setView).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('dispose() removes the idle-reset listener, so a later event does nothing', () => {
        const { map, setView } = fakeMap();
        const settings = settingsWith({ lat: 68.72, lng: 15.42, zoom: 13 });
        const target = new EventTarget();

        const dispose = startHomeViewSync(map, { settings, target });
        dispose();

        target.dispatchEvent(new CustomEvent(IDLE_RESET_EVENT));

        expect(setView).toHaveBeenCalledTimes(1); // only the initial mount-time call
    });
});
