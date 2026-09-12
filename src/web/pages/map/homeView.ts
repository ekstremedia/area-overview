/**
 * The map's home view: `settings.homeView` is the ONLY source of the
 * initial center/zoom -- no `fitBounds`, no env var, no deriving a center
 * from a weather payload. Applied once on mount and again whenever the
 * shell's idle-reset fires (`IDLE_RESET_EVENT`, see `shell/idle.ts`), and
 * nowhere else: a `homeView` change in settings takes effect on the
 * *next* mount/idle-reset, not reactively while the user might currently
 * be panning the map -- `startHomeViewSync` deliberately reads
 * `settingsSignal.get()` imperatively at those two moments only, rather
 * than inside an `effect()` that would re-run on every settings poll.
 */
import type * as Leaflet from 'leaflet';
import type { Settings } from '../../../shared/schemas/settings.js';
import type { ReadonlySignal } from '../../core/signal.js';
import { IDLE_RESET_EVENT } from '../../shell/idle.js';
import { settings as sharedSettings } from '../../settings-resource.js';

/**
 * The zoom a located position lands at.
 *
 * The shared home view sits at 11 because it frames a region; a located
 * position is a point, so it earns one step tighter. Deliberately not
 * closer than that: coordinates are rounded to two decimals before they
 * ever reach this code (`web/geolocation.ts`), and drawing the map at a
 * zoom finer than the datum would imply a precision that was thrown away
 * on purpose.
 */
export const LOCATED_ZOOM = 12;

export function applyHomeView(map: Leaflet.Map, homeView: Settings['homeView']): void {
    map.setView([homeView.lat, homeView.lng], homeView.zoom);
}

/** Reads the map's current center/zoom back out, in the same shape as `Settings['homeView']` -- for a future "use current map position" control (Phase 9). Not consumed by anything in this phase. */
export function readCurrentView(map: Leaflet.Map): Settings['homeView'] {
    const center = map.getCenter();
    return { lat: center.lat, lng: center.lng, zoom: map.getZoom() };
}

export interface StartHomeViewSyncOptions {
    /** Reactive source of `homeView`. Defaults to the shared settings resource; tests inject their own (same pattern as `shell/idle.ts`'s `StartIdleResetOptions`). */
    settings?: ReadonlySignal<Settings>;
    /** Defaults to `window`, where `startIdleReset` dispatches `IDLE_RESET_EVENT`. */
    target?: EventTarget;
}

/**
 * Applies `settings.homeView` to `map` once immediately, and again every
 * time `IDLE_RESET_EVENT` fires -- never reactively on an unrelated
 * settings poll in between. Returns a disposer that removes the event
 * listener.
 */
export function startHomeViewSync(map: Leaflet.Map, options: StartHomeViewSyncOptions = {}): () => void {
    const settingsSignal = options.settings ?? sharedSettings;
    const target = options.target ?? window;

    applyHomeView(map, settingsSignal.get().homeView);

    function onIdleReset(): void {
        applyHomeView(map, settingsSignal.get().homeView);
    }

    target.addEventListener(IDLE_RESET_EVENT, onIdleReset);

    return function dispose(): void {
        target.removeEventListener(IDLE_RESET_EVENT, onIdleReset);
    };
}
