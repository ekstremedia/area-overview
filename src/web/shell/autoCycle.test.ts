import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import { signal } from '../core/signal.js';
import { nextCycleRoute, startAutoCycle } from './autoCycle.js';

function settingsWith(overrides: Partial<Settings['autoCycle']> = {}, enabledPages?: Settings['enabledPages']): Settings {
    return SettingsSchema.parse({
        autoCycle: { enabled: true, intervalSeconds: 180, pages: [], ...overrides },
        ...(enabledPages ? { enabledPages } : {}),
    });
}

describe('nextCycleRoute', () => {
    it('returns null when auto-cycle is disabled', () => {
        const settings = SettingsSchema.parse({ autoCycle: { enabled: false, intervalSeconds: 180, pages: [] } });
        expect(nextCycleRoute('map', settings)).toBeNull();
    });

    it('an empty pages list falls back to every currently-enabled page', () => {
        const settings = settingsWith({ pages: [] }, ['map', 'weather', 'aurora']);
        expect(nextCycleRoute('map', settings)).toBe('weather');
    });

    it('a non-empty pages list cycles only those pages, in canonical order', () => {
        const settings = settingsWith({ pages: ['tide', 'map'] });
        expect(nextCycleRoute('map', settings)).toBe('tide');
        expect(nextCycleRoute('tide', settings)).toBe('map');
    });

    it('wraps around from the last eligible page back to the first', () => {
        const settings = settingsWith({ pages: [] }, ['map', 'weather', 'aurora', 'tide', 'cameras']);
        expect(nextCycleRoute('cameras', settings)).toBe('map');
    });

    it('skips a page that is in autoCycle.pages but has since been disabled via enabledPages', () => {
        const settings = settingsWith({ pages: ['map', 'weather', 'aurora'] }, ['map', 'aurora']); // weather disabled
        expect(nextCycleRoute('map', settings)).toBe('aurora');
        expect(nextCycleRoute('aurora', settings)).toBe('map');
    });

    it('returns null when fewer than two pages are eligible', () => {
        const settings = settingsWith({ pages: ['map'] });
        expect(nextCycleRoute('map', settings)).toBeNull();
    });

    it('returns null when autoCycle.pages and enabledPages have no overlap', () => {
        const settings = settingsWith({ pages: ['weather', 'aurora'] }, ['map', 'tide']);
        expect(nextCycleRoute('map', settings)).toBeNull();
    });

    it('starts from the first eligible page when the current route is not itself eligible (e.g. #/settings)', () => {
        const settings = settingsWith({ pages: [] }, ['map', 'weather', 'aurora']);
        expect(nextCycleRoute('settings', settings)).toBe('map');
    });

    it('starts from the first eligible page when the current route was disabled mid-cycle', () => {
        const settings = settingsWith({ pages: [] }, ['weather', 'aurora']); // 'map' no longer eligible
        expect(nextCycleRoute('map', settings)).toBe('weather');
    });
});

describe('startAutoCycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does nothing when auto-cycle is disabled', () => {
        const settingsSignal = signal(SettingsSchema.parse({ autoCycle: { enabled: false, intervalSeconds: 30, pages: [] } }));
        const routeSignal = signal<{ name: 'map' }>({ name: 'map' });
        const onCycle = vi.fn();
        const dispose = startAutoCycle({ settings: settingsSignal, route: routeSignal, onCycle });

        vi.advanceTimersByTime(60_000);
        expect(onCycle).not.toHaveBeenCalled();

        dispose();
    });

    it('fires onCycle with the next route every intervalSeconds', () => {
        const settingsSignal = signal(
            SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] }, enabledPages: ['map', 'weather'] }),
        );
        const routeSignal = signal<{ name: 'map' }>({ name: 'map' });
        const onCycle = vi.fn();
        const dispose = startAutoCycle({ settings: settingsSignal, route: routeSignal, onCycle });

        vi.advanceTimersByTime(29_000);
        expect(onCycle).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1_000);
        expect(onCycle).toHaveBeenCalledTimes(1);
        expect(onCycle).toHaveBeenCalledWith('weather');

        dispose();
    });

    it('re-arms with a new interval when intervalSeconds changes, without waiting out the old one', () => {
        const settingsSignal = signal(
            SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 100, pages: [] }, enabledPages: ['map', 'weather'] }),
        );
        const routeSignal = signal<{ name: 'map' }>({ name: 'map' });
        const onCycle = vi.fn();
        const dispose = startAutoCycle({ settings: settingsSignal, route: routeSignal, onCycle });

        vi.advanceTimersByTime(50_000);
        settingsSignal.set({ ...settingsSignal.get(), autoCycle: { ...settingsSignal.get().autoCycle, intervalSeconds: 30 } });

        vi.advanceTimersByTime(29_000);
        expect(onCycle).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1_000);
        expect(onCycle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('does not reset the running countdown on a settings update that leaves enabled/intervalSeconds/pages unchanged', () => {
        const settingsSignal = signal(
            SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] }, enabledPages: ['map', 'weather'] }),
        );
        const routeSignal = signal<{ name: 'map' }>({ name: 'map' });
        const onCycle = vi.fn();
        const dispose = startAutoCycle({ settings: settingsSignal, route: routeSignal, onCycle });

        vi.advanceTimersByTime(25_000);
        // A settings poll landing with the same autoCycle fields (e.g. every
        // pollIntervalSeconds) must not restart the countdown.
        settingsSignal.set({ ...settingsSignal.get(), brightness: 42 });

        vi.advanceTimersByTime(5_000);
        expect(onCycle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('reflects a live enabledPages change on the very next tick without re-arming the timer', () => {
        const settingsSignal = signal(
            SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] }, enabledPages: ['map', 'weather'] }),
        );
        const routeSignal = signal<{ name: 'map' }>({ name: 'map' });
        const onCycle = vi.fn();
        const dispose = startAutoCycle({ settings: settingsSignal, route: routeSignal, onCycle });

        // enabledPages changes mid-countdown -- must not restart the 30s timer.
        vi.advanceTimersByTime(15_000);
        settingsSignal.set({ ...settingsSignal.get(), enabledPages: ['map', 'aurora'] });
        vi.advanceTimersByTime(15_000);

        expect(onCycle).toHaveBeenCalledTimes(1);
        expect(onCycle).toHaveBeenCalledWith('aurora');

        dispose();
    });

    it('keeps firing repeatedly, every interval, not just once', () => {
        const settingsSignal = signal(
            SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] }, enabledPages: ['map', 'weather'] }),
        );
        const routeSignal = signal<{ name: 'map' }>({ name: 'map' });
        const onCycle = vi.fn();
        const dispose = startAutoCycle({ settings: settingsSignal, route: routeSignal, onCycle });

        vi.advanceTimersByTime(95_000);
        expect(onCycle).toHaveBeenCalledTimes(3);

        dispose();
    });

    it('dispose() clears the timer, so nothing fires afterward', () => {
        const settingsSignal = signal(
            SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] }, enabledPages: ['map', 'weather'] }),
        );
        const routeSignal = signal<{ name: 'map' }>({ name: 'map' });
        const onCycle = vi.fn();
        const dispose = startAutoCycle({ settings: settingsSignal, route: routeSignal, onCycle });

        dispose();
        vi.advanceTimersByTime(60_000);

        expect(onCycle).not.toHaveBeenCalled();
    });
});
