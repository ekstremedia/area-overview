/**
 * A minimal registry primitive so a future live layer (ships, aircraft --
 * Phase 7) can mount into the shared Leaflet map instance without
 * `MapPage.ts` needing to know about it directly. Deliberately not the
 * full `LiveLayerSpec<T>` contract (polling cadence, validation, marker
 * rendering) -- `src/shared/layers.ts` reserves that for Phase 7, once
 * there are at least two concrete layers to generalise from. Cameras do
 * NOT go through this registry; they stay hand-wired in `MapPage.ts`/
 * `markers.ts` per Terje's explicit choice.
 */
import type * as Leaflet from 'leaflet';

/** A layer's mount function: given the map, start whatever it needs and return its own disposer. */
export type MapLayerMount = (map: Leaflet.Map) => () => void;

/** Runs `mount` against `map` and hands back a disposer -- the smallest possible wrapper, so Phase 7 has a stable, tested seam to build a real registry on top of without this phase guessing at its shape. */
export function registerMapLayer(map: Leaflet.Map, mount: MapLayerMount): () => void {
    return mount(map);
}
