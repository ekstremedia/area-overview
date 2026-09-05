import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import { startIdleReset } from './idle.js';

function settingsWith(idleResetSeconds: number) {
    return signal<Settings>(SettingsSchema.parse({ idleResetSeconds }));
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('startIdleReset', () => {
    it('defaults to navigating to the map route (#/) when no onIdle is given', () => {
        location.hash = '#/weather';
        const dispose = startIdleReset({ settings: settingsWith(300) });

        vi.advanceTimersByTime(300_000);
        expect(location.hash).toBe('#/');

        dispose();
    });

    it('fires onIdle after idleResetSeconds of no activity', () => {
        const onIdle = vi.fn();
        const dispose = startIdleReset({ settings: settingsWith(300), onIdle });

        vi.advanceTimersByTime(299_000);
        expect(onIdle).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1_000);
        expect(onIdle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('resets the timer on pointerdown activity', () => {
        const onIdle = vi.fn();
        const dispose = startIdleReset({ settings: settingsWith(10), onIdle });

        vi.advanceTimersByTime(9_000);
        window.dispatchEvent(new Event('pointerdown'));
        vi.advanceTimersByTime(9_000);
        // Still within 10s of the pointerdown reset, so no fire yet.
        expect(onIdle).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1_000);
        expect(onIdle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('resets the timer on keydown activity', () => {
        const settingsSignal = settingsWith(10);
        const onIdle = vi.fn();
        const dispose = startIdleReset({ settings: settingsSignal, onIdle });

        vi.advanceTimersByTime(9_000);
        window.dispatchEvent(new Event('keydown'));
        vi.advanceTimersByTime(9_000);
        expect(onIdle).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1_000);
        expect(onIdle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('never fires when idleResetSeconds is 0, even after a long time', () => {
        const onIdle = vi.fn();
        const dispose = startIdleReset({ settings: settingsWith(0), onIdle });

        vi.advanceTimersByTime(1000 * 60 * 60 * 24);
        expect(onIdle).not.toHaveBeenCalled();

        dispose();
    });

    it('re-arms with a new duration when idleResetSeconds changes, without needing activity', () => {
        const settingsSignal = settingsWith(100);
        const onIdle = vi.fn();
        const dispose = startIdleReset({ settings: settingsSignal, onIdle });

        vi.advanceTimersByTime(50_000);
        settingsSignal.set({ ...settingsSignal.get(), idleResetSeconds: 20 });

        // The new, shorter duration is what now governs the next fire.
        vi.advanceTimersByTime(19_000);
        expect(onIdle).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1_000);
        expect(onIdle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('does not reset the running countdown on a settings update that leaves idleResetSeconds unchanged', () => {
        const settingsSignal = settingsWith(30);
        const onIdle = vi.fn();
        const dispose = startIdleReset({ settings: settingsSignal, onIdle });

        vi.advanceTimersByTime(25_000);
        // A settings poll landing with the *same* idleResetSeconds (e.g. every
        // pollIntervalSeconds) must not look like activity and restart the countdown.
        settingsSignal.set({ ...settingsSignal.get(), brightness: 42 });

        vi.advanceTimersByTime(5_000);
        expect(onIdle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('dispose() removes listeners and clears the timer, so nothing fires afterward', () => {
        const onIdle = vi.fn();
        const dispose = startIdleReset({ settings: settingsWith(10), onIdle });

        dispose();
        vi.advanceTimersByTime(60_000);
        window.dispatchEvent(new Event('pointerdown'));
        vi.advanceTimersByTime(60_000);

        expect(onIdle).not.toHaveBeenCalled();
    });
});
