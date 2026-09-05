/**
 * The reusable half of the live-layer contract every concrete layer
 * (`ships.ts`, `aircraft.ts`, and any future one) builds its own
 * `mount<Name>Layer(L, map, callbacks)` function on top of: reactive
 * mount/unmount tied to `settings.<id>.enabled` (so a toggle on the
 * settings page -- Phase 9, not built yet -- takes effect immediately,
 * with no page reload), and reading the map's current viewport as a bbox
 * query string at poll time.
 *
 * Kept separate from `layers.ts` (which composes the concrete layers
 * together into `mountLiveLayers`) specifically to avoid a circular
 * import: `layers.ts` imports `ships.ts`/`aircraft.ts`, and those import
 * this file, not `layers.ts` itself.
 */
import type * as Leaflet from 'leaflet';
import { effect } from '../../core/signal.js';

export interface LiveLayerCallbacks {
    /** The number of glyphs currently rendered (post age-filter) -- feeds the masthead's live-layer counts. Call with `0` when disabled/unconfigured. */
    reportCount(count: number): void;
    /** This layer's attribution text while active, or `undefined` while disabled/unconfigured -- feeds the footer's attribution line. */
    reportAttribution(text: string | undefined): void;
}

/**
 * Runs `mount()` (and holds onto its disposer) whenever `isEnabled()`
 * currently reads `true`, and calls that disposer the moment it reads
 * `false` -- reactively, via an `effect()`, so a settings change flips
 * this without the map page needing to be re-entered.
 */
export function mountWhileEnabled(isEnabled: () => boolean, mount: () => () => void): () => void {
    let disposeInner: (() => void) | undefined;

    const disposeEffect = effect(() => {
        const enabled = isEnabled();
        if (enabled && !disposeInner) {
            disposeInner = mount();
        } else if (!enabled && disposeInner) {
            disposeInner();
            disposeInner = undefined;
        }
    });

    return function dispose(): void {
        disposeEffect();
        disposeInner?.();
        disposeInner = undefined;
    };
}

/** The map's current viewport as a `minLng,minLat,maxLng,maxLat` bbox query value, read fresh at call time -- never a value captured once at mount. */
export function mapToBboxQuery(map: Leaflet.Map): string {
    const bounds = map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
}
