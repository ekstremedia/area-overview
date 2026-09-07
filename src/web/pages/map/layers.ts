/**
 * The live-layer registry: composes the concrete layers (ships,
 * aircraft, and any future one) onto the shared Leaflet map instance
 * without `MapPage.ts` needing to know about any of them directly.
 * `MapPage.ts` calls only `mountLiveLayers` from this file -- a third
 * layer is added here, by importing its own `mount<Name>Layer` function
 * and adding one more `registerMapLayer(...)` call below, with zero
 * change to `MapPage.ts`.
 *
 * Cameras do NOT go through this registry; they stay hand-wired in
 * `MapPage.ts`/`markers.ts` per Terje's explicit choice.
 */
import type * as Leaflet from 'leaflet';
import { liveLayerCounts, liveLayerListing, pageAttribution, type LayerCounts, type LiveLayerItem } from '../../shell/page-status.js';
import { mountAircraftLayer } from './aircraft.js';
import { mountShipsLayer } from './ships.js';

/** A layer's mount function: given the map, start whatever it needs and return its own disposer. */
export type MapLayerMount = (map: Leaflet.Map) => () => void;

/** Runs `mount` against `map` and hands back a disposer -- the smallest possible wrapper around a layer's own mount function. */
export function registerMapLayer(map: Leaflet.Map, mount: MapLayerMount): () => void {
    return mount(map);
}

type LayerId = keyof LayerCounts;

/**
 * Mounts every live layer, combining their individually-reported counts
 * into the one `{ships, aircraft}` object the masthead reads, and their
 * individually-reported attribution strings into the one joined line the
 * footer reads. Both are reset to their "nothing to report" defaults
 * (`null`) on this function's own dispose, so leaving the map page never
 * leaves a stale ship/aircraft attribution or count behind on another
 * page.
 */
export function mountLiveLayers(L: typeof Leaflet, map: Leaflet.Map): () => void {
    const counts: LayerCounts = { ships: 0, aircraft: 0, hiddenByAge: 0 };
    const attributions = new Map<LayerId, string>();
    // Per-layer, so one layer's report never clobbers the other's share of
    // the single combined figure the masthead shows.
    const hiddenByAge = new Map<LayerId, number>();
    const items = new Map<LayerId, LiveLayerItem[]>();

    /**
     * Zoomed in far enough that the vessel fills the view rather than
     * being a dot in it, but not so far that the surrounding coastline
     * disappears and the position loses its context.
     */
    const FOCUS_ZOOM = 13;

    function publishListing(): void {
        liveLayerListing.set({
            ships: items.get('ships') ?? [],
            aircraft: items.get('aircraft') ?? [],
            focus: (item) => {
                map.setView([item.lat, item.lng], Math.max(map.getZoom(), FOCUS_ZOOM));
            },
        });
    }

    function reportItems(id: LayerId, next: readonly LiveLayerItem[]): void {
        items.set(id, [...next]);
        publishListing();
    }

    function reportCount(id: LayerId, count: number, hidden: number): void {
        counts[id] = count;
        hiddenByAge.set(id, hidden);
        counts.hiddenByAge = [...hiddenByAge.values()].reduce((total, value) => total + value, 0);
        liveLayerCounts.set({ ...counts });
    }

    function reportAttribution(id: LayerId, text: string | undefined): void {
        if (text === undefined) {
            attributions.delete(id);
        } else {
            attributions.set(id, text);
        }
        pageAttribution.set(attributions.size === 0 ? null : [...attributions.values()].join(' · '));
    }

    liveLayerCounts.set({ ...counts });
    publishListing();

    const disposeShips = registerMapLayer(map, (m) =>
        mountShipsLayer(L, m, {
            reportCount: (count, hidden) => {
                reportCount('ships', count, hidden);
            },
            reportAttribution: (text) => {
                reportAttribution('ships', text);
            },
            reportItems: (next) => {
                reportItems('ships', next);
            },
        }),
    );
    const disposeAircraft = registerMapLayer(map, (m) =>
        mountAircraftLayer(L, m, {
            reportCount: (count, hidden) => {
                reportCount('aircraft', count, hidden);
            },
            reportAttribution: (text) => {
                reportAttribution('aircraft', text);
            },
            reportItems: (next) => {
                reportItems('aircraft', next);
            },
        }),
    );

    return function dispose(): void {
        disposeShips();
        disposeAircraft();
        liveLayerCounts.set(null);
        liveLayerListing.set(null);
        pageAttribution.set(null);
    };
}
