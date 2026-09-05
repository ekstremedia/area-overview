/**
 * Idle-reset: fires `onIdle` after `settings.idleResetSeconds` of no
 * touch/key activity. What "reset" means (navigate to `#/`, close
 * popups) is the caller's problem -- this module only owns the timer.
 *
 * `IDLE_RESET_EVENT` is a second, event-based notification fired on
 * `target` (`window` by default) at the same moment `onIdle` runs. It
 * exists for a page that's *already mounted on the idle destination* and
 * therefore never sees a `hashchange`/route change to react to (the
 * default `onIdle` sets `location.hash = '#/'`, which is a no-op -- no
 * event at all -- when the hash is already `#/`): `MapPage.ts` listens for
 * this event to re-apply `settings.homeView` without needing a remount.
 */
import type { Settings } from '../../shared/schemas/settings.js';
import { effect, type ReadonlySignal } from '../core/signal.js';
import { settings as sharedSettings } from '../settings-resource.js';

export const IDLE_RESET_EVENT = 'area-overview:idle-reset';

export interface StartIdleResetOptions {
    /** Reactive source of `idleResetSeconds`. Defaults to the shared settings resource; tests inject their own. */
    settings?: ReadonlySignal<Settings>;
    /** Called when the idle timer fires. Defaults to navigating to the map route. */
    onIdle?: () => void;
    /** Defaults to `window`. Tests never need to override this; present for symmetry/testability. */
    target?: EventTarget;
}

const DEFAULT_ON_IDLE = (): void => {
    location.hash = '#/';
};

export function startIdleReset(options: StartIdleResetOptions = {}): () => void {
    const settingsSignal = options.settings ?? sharedSettings;
    const onIdle = options.onIdle ?? DEFAULT_ON_IDLE;
    const target = options.target ?? window;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Tracks the last-armed duration so a settings *poll* that leaves
    // `idleResetSeconds` unchanged doesn't reset the in-flight countdown
    // -- only a genuine change to the value re-arms the timer. Without
    // this, polling settings every `pollIntervalSeconds` (default 30s,
    // well under most idle timeouts) would look like continuous activity
    // and the reset would never fire.
    let lastArmedSeconds: number | undefined;

    function clear(): void {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    }

    function fire(): void {
        target.dispatchEvent(new CustomEvent(IDLE_RESET_EVENT));
        onIdle();
    }

    function arm(seconds: number): void {
        clear();
        if (seconds <= 0) return; // 0 disables idle-reset entirely: no timer at all.
        timer = setTimeout(fire, seconds * 1000);
    }

    const disposeEffect = effect(() => {
        const seconds = settingsSignal.get().idleResetSeconds;
        if (seconds !== lastArmedSeconds) {
            lastArmedSeconds = seconds;
            arm(seconds);
        }
    });

    function onActivity(): void {
        arm(settingsSignal.get().idleResetSeconds);
    }

    target.addEventListener('pointerdown', onActivity);
    target.addEventListener('keydown', onActivity);

    return function dispose(): void {
        disposeEffect();
        clear();
        target.removeEventListener('pointerdown', onActivity);
        target.removeEventListener('keydown', onActivity);
    };
}
