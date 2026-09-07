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

/**
 * Long enough to coalesce a flurry of `moveend`s (a drag that ends in
 * several small corrections, a double-tap zoom) into one fetch, short
 * enough that ships appear in newly-revealed water as part of the same
 * gesture rather than as a later surprise.
 */
const MOVE_REFETCH_DEBOUNCE_MS = 400;

/**
 * Refetches (debounced) whenever the map settles somewhere new.
 *
 * Both live layers fetch by the visible bbox, so a pan or zoom invalidates
 * the answer they are currently showing: water that just scrolled into
 * view holds no ships until the next poll, up to a full `pollSeconds`
 * later. `moveend` covers both cases -- Leaflet fires it after a zoom as
 * well as a pan -- which is why this is the only hook needed.
 *
 * (`zoomend` stays wired separately in `ships.ts` for re-clustering: that
 * one is instant and local, recomputing pixel distances from data already
 * in hand, and shouldn't wait on a network round trip.)
 *
 * Note that `mapToBboxQuery`'s `invalidateSize` can itself fire `moveend`
 * -- but only when the size genuinely changed, and the very next fetch
 * then finds the sizes agreeing and invalidates nothing. So a stale size
 * costs one extra fetch and settles, rather than looping; and that extra
 * fetch is the right thing anyway, since a resized viewport really does
 * show a different rectangle.
 */
export function refetchOnMapMove(map: Leaflet.Map, refresh: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function onMoveEnd(): void {
        clearTimeout(timer);
        timer = setTimeout(refresh, MOVE_REFETCH_DEBOUNCE_MS);
    }

    map.on('moveend', onMoveEnd);

    return function dispose(): void {
        clearTimeout(timer);
        map.off('moveend', onMoveEnd);
    };
}

/**
 * Re-measures the map's container if Leaflet's cached size no longer
 * matches it.
 *
 * Leaflet measures the container once and caches it (`Map.getSize`),
 * re-measuring only when its own window `resize` handler runs -- and that
 * handler defers the re-measure to `requestAnimationFrame`, which does
 * not run at all while the tab is hidden. `resource.ts` fires an
 * immediate catch-up fetch the moment a hidden tab becomes visible again,
 * so that fetch can read `getBounds()` while the cached size is still the
 * stale one, ask the BFF for the wrong rectangle, and render the answer
 * as if it were the viewport on screen -- a handful of ships, or one,
 * instead of the area actually being looked at. Nothing in this app calls
 * `invalidateSize` otherwise, so a size that goes stale stays stale.
 *
 * Comparing against the live container size first keeps this cheap: the
 * common case is two integer comparisons per poll and no Leaflet work at
 * all. `pan`/`animate` are off because this is a correction of Leaflet's
 * bookkeeping, not a view change the visitor asked for.
 */
function ensureFreshSize(map: Leaflet.Map): void {
    const container = map.getContainer();
    const size = map.getSize();
    if (size.x === container.clientWidth && size.y === container.clientHeight) return;
    map.invalidateSize({ animate: false, pan: false });
}

/**
 * The map's current viewport as a `minLng,minLat,maxLng,maxLat` bbox
 * query value, read fresh at call time -- never a value captured once at
 * mount -- or `null` when the map has no usable viewport to describe.
 *
 * `null` means "don't ask": a zero-width or zero-height container (not
 * laid out yet, or hidden) collapses `getBounds()` to a single point, and
 * a point bbox returns nothing. Callers must skip the request rather than
 * pass the degenerate value on, because an empty response is
 * indistinguishable from a genuine "no ships here" and would wipe the
 * layer.
 */
export function mapToBboxQuery(map: Leaflet.Map): string | null {
    ensureFreshSize(map);
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return null;
    const bounds = map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
}
