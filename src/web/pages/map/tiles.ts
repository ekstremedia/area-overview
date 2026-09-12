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

/**
 * A basemap that can actually be drawn. The two themed ones are what the
 * app picked automatically before the basemap button existed; `satellite`
 * has no themed counterpart -- aerial imagery is neither dark nor light,
 * it is just the ground.
 */
export type Basemap = 'dark' | 'light' | 'satellite';

/** What the device asked for: a specific basemap, or `auto` -- follow the theme, which is what the app did before this control existed. */
export type BasemapChoice = 'auto' | Basemap;

/**
 * The order the basemap button cycles through, and the order they read in
 * as a list: darkest to most detailed.
 */
export const BASEMAP_CYCLE: readonly Basemap[] = ['dark', 'light', 'satellite'];

/** The basemap one press of the button moves to, wrapping at the end. */
export function nextBasemap(current: Basemap): Basemap {
    const index = BASEMAP_CYCLE.indexOf(current);
    return BASEMAP_CYCLE[(index + 1) % BASEMAP_CYCLE.length] ?? 'dark';
}

/** The basemap to draw for a device's `choice` given the currently-resolved `theme`. An explicit choice wins; `auto` is the themed basemap of the same name. */
export function resolveBasemap(choice: BasemapChoice, theme: Theme): Basemap {
    return choice === 'auto' ? theme : choice;
}

export interface TileSpec {
    url: string;
    attribution: string;
}

/**
 * CARTO's raster basemap CDN now requires a `key` query parameter (added
 * 2025-ish, per CARTO's own FAQ at docs.carto.com/faqs/carto-basemaps):
 * without it, tiles still load (200, not blocked) but are covered by a
 * repeated "API key required" watermark baked into the PNG itself.
 * Verified against the real endpoint: a keyed request returns a smaller,
 * unwatermarked image than the same tile fetched without a key. The URL
 * *shape* (`{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`) is
 * unchanged -- only the trailing `?key=` is new. `light` (OSM) needs no
 * key at all and is unaffected by any of this.
 */
const TILE_SPECS: Record<Basemap, TileSpec> = {
    dark: {
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attribution: '© OSM · © CARTO',
    },
    light: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap',
    },
    /**
     * Esri's World Imagery, the same free raster service Leaflet's own
     * basemap-provider list ships: no key, no sign-up, and genuine
     * coverage of Vesterålen rather than the low-resolution fallback some
     * global imagery sets have this far north. Note the `{z}/{y}/{x}`
     * order -- Esri's tile REST path puts row before column, unlike every
     * other URL in this file, and swapping them silently returns tiles
     * from somewhere else entirely rather than a 404.
     *
     * Imagery only, no place labels: the app draws its own labels
     * (cameras, ships, aircraft) and a second overlay layer would double
     * the tile traffic on a kiosk that is already polling three live
     * sources.
     */
    satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri · Maxar, Earthstar Geographics',
    },
};

/**
 * `cartoApiKey` is appended as `?key=` to the `dark` basemap's URL when
 * non-empty; ignored for `light` and `satellite`, which are
 * CARTO-independent. An empty key leaves the URL as-is -- CARTO still
 * serves the tile, just watermarked, so this deliberately doesn't invent
 * a fallback tile source or block rendering.
 */
export function tileUrlFor(basemap: Basemap, cartoApiKey = ''): TileSpec {
    const spec = TILE_SPECS[basemap];
    if (basemap !== 'dark' || cartoApiKey === '') return spec;
    return { ...spec, url: `${spec.url}?key=${encodeURIComponent(cartoApiKey)}` };
}

/** The real host a browser will actually connect to for `basemap`'s tiles, for a `<link rel="preconnect">`. Drops the `{s}.` subdomain placeholder (CARTO); OSM and Esri have none. */
export function preconnectOriginFor(basemap: Basemap): string {
    const spec = tileUrlFor(basemap);
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
 * Applies `basemap`'s tiles to `map`. A no-op if that URL is already
 * the one currently applied (comparing against closure/WeakMap-held
 * state, not by re-deriving the basemap). Otherwise: add the new layer
 * first, and only remove the old one once the new layer's `load` event
 * fires (or the safety timeout elapses) -- never remove-then-add, which
 * would blank the map for the round trip to the tile host.
 *
 * `cartoApiKey` is threaded straight through to `tileUrlFor` -- see its
 * docstring. A no-op check based on `spec.url` (not the raw `basemap`)
 * means fetching the key *after* an unkeyed `dark` tile layer is already
 * showing correctly swaps to the keyed URL on the next `applyTiles` call.
 */
export function applyTiles(L: typeof Leaflet, map: Leaflet.Map, basemap: Basemap, cartoApiKey = ''): void {
    const spec = tileUrlFor(basemap, cartoApiKey);
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
