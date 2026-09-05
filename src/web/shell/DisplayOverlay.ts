/**
 * The night/brightness overlay (artboard 09): one full-screen,
 * `pointer-events: none` div above everything else, whose opacity is
 * driven by `settings.brightness` and, while `settings.night`'s schedule
 * is active, overridden per `mode`:
 *   - `dim`  -- force opacity to 0.62 (the design's stated default).
 *   - `off`  -- force opacity to 1 (fully black); any tap anywhere lifts
 *              it to 0 for 30 seconds, then it re-darkens.
 *   - `dark` -- no overlay at all (opacity 0); `theme.ts` forces the dark
 *              theme for the window instead.
 * Outside any active schedule, opacity is `1 - brightness/100`.
 */
import { effect, signal } from '../core/signal.js';
import { settings } from '../settings-resource.js';
import { nightSchedule } from './night-schedule.js';

const OFF_MODE_DIM_OPACITY = '1';
const OFF_MODE_LIFT_OPACITY = '0';
const DIM_MODE_OPACITY = '0.62';
const LIFT_DURATION_MS = 30_000;

export function mountDisplayOverlay(host: HTMLElement = document.body): () => void {
    const overlay = document.createElement('div');
    overlay.className = 'display-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    host.appendChild(overlay);

    const lifted = signal(false);
    let liftTimer: ReturnType<typeof setTimeout> | undefined;

    function onTap(): void {
        const night = nightSchedule.get();
        if (night.mode !== 'off' || !night.active) return;
        lifted.set(true);
        if (liftTimer !== undefined) clearTimeout(liftTimer);
        liftTimer = setTimeout(() => {
            lifted.set(false);
        }, LIFT_DURATION_MS);
    }

    window.addEventListener('pointerdown', onTap);

    const disposeEffect = effect(() => {
        const night = nightSchedule.get();

        if (night.active && night.mode === 'dark') {
            // theme.ts owns forcing the dark theme for this window; the
            // overlay itself is invisible.
            overlay.style.opacity = OFF_MODE_LIFT_OPACITY;
            return;
        }

        if (night.active && night.mode === 'dim') {
            overlay.style.opacity = DIM_MODE_OPACITY;
            return;
        }

        if (night.active && night.mode === 'off') {
            overlay.style.opacity = lifted.get() ? OFF_MODE_LIFT_OPACITY : OFF_MODE_DIM_OPACITY;
            return;
        }

        const brightness = settings.get().brightness;
        overlay.style.opacity = String(1 - brightness / 100);
    });

    return function dispose(): void {
        disposeEffect();
        window.removeEventListener('pointerdown', onTap);
        if (liftTimer !== undefined) clearTimeout(liftTimer);
        overlay.remove();
    };
}
