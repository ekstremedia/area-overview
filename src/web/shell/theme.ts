/**
 * Applies device settings (`theme`, `fontScale`) and the night schedule's
 * `dark` mode to the document. Instant, no reload: both are `effect()`s
 * that write straight to `<html>` whenever their inputs change.
 *
 * `theme: 'system'` follows `prefers-color-scheme` via a `matchMedia`
 * listener. Night schedule `mode: 'dark'` forces the dark theme for the
 * scheduled window regardless of the device's own theme setting (and, by
 * design, shows no overlay -- `DisplayOverlay.ts` handles that half).
 */
import type { DeviceSettings } from '../../shared/schemas/device-settings.js';
import { deviceSettings } from '../device-settings.js';
import { effect, signal } from '../core/signal.js';
import { nightSchedule } from './night-schedule.js';

function resolveBaseTheme(theme: DeviceSettings['theme'], prefersLight: boolean): 'dark' | 'light' {
    if (theme === 'system') return prefersLight ? 'light' : 'dark';
    return theme;
}

/** Applies `data-theme` to `<html>`. Returns a disposer removing the media-query listener and the underlying effect. */
export function startThemeApplication(root: HTMLElement = document.documentElement): () => void {
    const mql = matchMedia('(prefers-color-scheme: light)');
    // `matchMedia`'s own `.matches` isn't itself a signal; this local
    // signal exists purely to give the `effect()` below something to
    // re-read when the media query flips, without recreating the effect.
    const systemPrefersLight = signal(mql.matches);
    const onChange = (event: MediaQueryListEvent): void => {
        systemPrefersLight.set(event.matches);
    };
    mql.addEventListener('change', onChange);

    const disposeEffect = effect(() => {
        const night = nightSchedule.get();
        const base = resolveBaseTheme(deviceSettings.get().theme, systemPrefersLight.get());
        const theme = night.mode === 'dark' && night.active ? 'dark' : base;
        root.setAttribute('data-theme', theme);
    });

    return () => {
        disposeEffect();
        mql.removeEventListener('change', onChange);
    };
}

/** Multiplies the root font size by `fontScale`. Returns a disposer. */
export function startFontScaleApplication(root: HTMLElement = document.documentElement): () => void {
    return effect(() => {
        root.style.setProperty('--font-scale-multiplier', String(deviceSettings.get().fontScale));
    });
}
