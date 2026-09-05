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
    safetyTimer: ReturnType<typeof setTimeout> | undefined;
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

    // `settle` closes over this call's own `state` object, not a fresh
    // `stateByMap.get(map)` lookup -- a second `applyTiles` call before this
    // one's timer/`load` fires replaces the WeakMap entry with its own state,
    // and a re-lookup here would let this call's `settle` clear (or act on)
    // a newer call's still-pending safety timer instead of its own.
    const state: TileMapState = { appliedUrl: spec.url, layer: newLayer, safetyTimer: undefined };
    let settled = false;

    // Idempotent: real Leaflet's `once('load', ...)` only fires once, but
    // nothing stops the safety timeout from *also* firing if `load` lands
    // right around the 4s mark, and this must not remove `previousLayer`
    // (or clear an already-cleared timer) twice.
    function settle(): void {
        if (settled) return;
        settled = true;
        if (state.safetyTimer !== undefined) {
            clearTimeout(state.safetyTimer);
            state.safetyTimer = undefined;
        }
        if (previousLayer) map.removeLayer(previousLayer);
    }

    newLayer.once('load', settle);
    newLayer.addTo(map);
    state.safetyTimer = setTimeout(settle, SAFETY_TIMEOUT_MS);

    stateByMap.set(map, state);
}

/** Tears down whatever tile layer/timer `applyTiles` last installed on `map`. Call from the map page's disposer. */
export function disposeTiles(map: Leaflet.Map): void {
    const state = stateByMap.get(map);
    if (!state) return;
    if (state.safetyTimer !== undefined) clearTimeout(state.safetyTimer);
    map.removeLayer(state.layer);
    stateByMap.delete(map);
}
