/**
 * Theme-switched tile layer, ported from `FjordPhotoMap.vue`'s tile logic
 * (see the phase packet for the exact upstream URLs/attribution). This is
 * the ONLY file in the codebase allowed to reference a CARTO/OSM tile URL
 * -- everything else asks `tileUrlFor`/`applyTiles`.
 *
 * `applyTiles` cannot statically `import` the `leaflet` package (that
 * would pull the whole library into the app's initial bundle, defeating
 * `MapPage.ts`'s dynamic `import('leaflet')`), so it takes the already-
 * imported Leaflet namespace as its first argument instead of reaching
 * for a module-level import. Only `import type` is used here, which
 * TypeScript erases entirely at build time.
 */
import type * as Leaflet from 'leaflet';

export type Theme = 'dark' | 'light';

export interface TileSpec {
    url: string;
    attribution: string;
}

const TILE_SPECS: Record<Theme, TileSpec> = {
    dark: {
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attribution: '© OSM · © CARTO',
    },
    light: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap',
    },
};

export function tileUrlFor(theme: Theme): TileSpec {
    return TILE_SPECS[theme];
}

/** The real host a browser will actually connect to for `theme`'s tiles, for a `<link rel="preconnect">`. Drops the `{s}.` subdomain placeholder (CARTO); OSM has none. */
export function preconnectOriginFor(theme: Theme): string {
    const spec = tileUrlFor(theme);
    return new URL(spec.url.replace('{s}.', '')).origin;
}

/** If the new tile layer's `load` event never fires (offline, blocked CDN, a tile 404 storm), the old layer is removed anyway after this long so the map isn't stuck showing two overlapping layers forever. */
const SAFETY_TIMEOUT_MS = 4000;

interface TileMapState {
    appliedUrl: string;
    layer: Leaflet.TileLayer;
    /**
     * Every safety timer still pending across ALL `applyTiles` calls on this
     * map, not just the most recent one -- two rapid theme switches within
     * the 4s window each start their own timer, and both must be reachable
     * so `disposeTiles` can clear every one of them, not just the newest
     * (an uncleared older timer could otherwise fire after the map page has
     * already disposed and call `map.removeLayer` on a torn-down map).
     */
    pendingTimers: Set<ReturnType<typeof setTimeout>>;
}

/** Per-map state, keyed by the `L.Map` instance itself so multiple independent maps (or repeated test doubles) never share state, and a disposed map's entry is dropped for GC along with it. */
const stateByMap = new WeakMap<Leaflet.Map, TileMapState>();

/**
 * Applies `theme`'s tiles to `map`. A no-op if `theme`'s URL is already
 * the one currently applied (comparing against closure/WeakMap-held
 * state, not by re-deriving the theme). Otherwise: add the new layer
 * first, and only remove the old one once the new layer's `load` event
 * fires (or the safety timeout elapses) -- never remove-then-add, which
 * would blank the map for the round trip to the tile host.
 */
export function applyTiles(L: typeof Leaflet, map: Leaflet.Map, theme: Theme): void {
    const spec = tileUrlFor(theme);
    const existing = stateByMap.get(map);
    if (existing?.appliedUrl === spec.url) return;

    const previousLayer = existing?.layer;
    const newLayer = L.tileLayer(spec.url, { attribution: spec.attribution });

    // Carried forward from `existing` (not created fresh) so a second
    // `applyTiles` call within the 4s safety window shares the same set as
    // the first -- `disposeTiles` below can then clear every pending timer,
    // not just the one from the most recent call.
    const pendingTimers = existing?.pendingTimers ?? new Set<ReturnType<typeof setTimeout>>();

    // `settle` closes over this call's own `state`/`previousLayer`, not a
    // fresh `stateByMap.get(map)` lookup -- a second `applyTiles` call before
    // this one's timer/`load` fires replaces the WeakMap entry with its own
    // state, and a re-lookup here would let this call's `settle` act on a
    // newer call's layer instead of its own.
    const state: TileMapState = { appliedUrl: spec.url, layer: newLayer, pendingTimers };
    let settled = false;
    // A mutable holder, not a bare `let`: `ownTimer.id` is set once, after
    // `settle` is defined below (the `setTimeout` call needs `settle` as its
    // callback), so `settle` must read it through a reference rather than
    // close over a variable assigned only after its own declaration.
    const ownTimer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };

    // Idempotent: real Leaflet's `once('load', ...)` only fires once, but
    // nothing stops the safety timeout from *also* firing if `load` lands
    // right around the 4s mark, and this must not remove `previousLayer`
    // (or clear an already-cleared timer) twice.
    function settle(): void {
        if (settled) return;
        settled = true;
        if (ownTimer.id !== undefined) {
            clearTimeout(ownTimer.id);
            pendingTimers.delete(ownTimer.id);
        }
        if (previousLayer) map.removeLayer(previousLayer);
    }

    newLayer.once('load', settle);
    newLayer.addTo(map);
    ownTimer.id = setTimeout(settle, SAFETY_TIMEOUT_MS);
    pendingTimers.add(ownTimer.id);

    stateByMap.set(map, state);
}

/** Tears down whatever tile layer/timers `applyTiles` installed on `map`, including any safety timer still pending from an earlier, superseded call. Call from the map page's disposer. */
export function disposeTiles(map: Leaflet.Map): void {
    const state = stateByMap.get(map);
    if (!state) return;
    for (const timer of state.pendingTimers) clearTimeout(timer);
    state.pendingTimers.clear();
    map.removeLayer(state.layer);
    stateByMap.delete(map);
}
