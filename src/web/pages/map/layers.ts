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
import { effect } from '../../core/signal.js';
import { t } from '../../i18n/index.js';
import {
    emptyLayerCounts,
    LIVE_LAYER_GROUP_IDS,
    type LayerCounts,
    type LiveLayerColors,
    type LiveLayerGroupId,
    type LiveLayerItem,
    type PageStatus,
} from '../../shell/page-status.js';
import { mountAircraftLayer } from './aircraft.js';
import { followTarget, stopFollowing } from './follow.js';
import { mountRoadCamerasLayer } from './roadCameras.js';
import { mountRoadsLayer } from './roads.js';
import { mountShipsLayer } from './ships.js';
import { mountTransitLayer } from './transit.js';
import { mountWarningsLayer } from './warnings.js';

/** A layer's mount function: given the map, start whatever it needs and return its own disposer. */
export type MapLayerMount = (map: Leaflet.Map) => () => void;

/** Runs `mount` against `map` and hands back a disposer -- the smallest possible wrapper around a layer's own mount function. */
export function registerMapLayer(map: Leaflet.Map, mount: MapLayerMount): () => void {
    return mount(map);
}

/**
 * The chip that appears over the map while a vessel is being followed:
 * what is being followed, and the way out of it.
 *
 * It earns its place twice over. The map holding station on a moving ship
 * is not otherwise explicable -- nothing else on screen says why the view
 * will not stay where it is put -- and the slideshow's countdown is
 * frozen at the same time, which without this would read as a stuck
 * kiosk rather than as a deliberate hold.
 *
 * Lives in the Leaflet container rather than in `MapPage.ts`'s wrapper so
 * it is positioned against the map itself, and is mounted here because
 * this is already where the two live layers meet: either of them can
 * start a follow, and there is only ever one chip.
 */
function mountFollowChip(L: typeof Leaflet, map: Leaflet.Map): () => void {
    const chip = document.createElement('div');
    chip.className = 'map-follow-chip';
    chip.hidden = true;

    const label = document.createElement('span');
    label.className = 'map-follow-chip-label';

    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'map-follow-chip-stop';
    stop.textContent = '\u2715';
    stop.addEventListener('click', () => {
        stopFollowing();
    });

    chip.append(label, stop);
    map.getContainer().append(chip);
    // The chip sits over the map: without this, a drag started on it would
    // pan the map underneath (and so cancel the very follow it describes).
    L.DomEvent.disableClickPropagation(chip);

    const disposeEffect = effect(() => {
        const target = followTarget.get();
        chip.hidden = target === null;
        if (target === null) return;
        label.textContent = t('map.followingVessel', { name: target.label });
        stop.setAttribute('aria-label', t('map.stopFollowing'));
    });

    return function dispose(): void {
        disposeEffect();
        chip.remove();
    };
}

/**
 * Mounts every live layer, combining their individually-reported counts
 * into the one group-keyed object the masthead reads, and their
 * individually-reported attribution strings into the one joined line the
 * footer reads. Clearing both again is `MapPage.ts`'s job, through its
 * `claimPageStatus()` release: the shell keeps the incoming page mounted
 * while the outgoing one is still on screen, so a slot cleared here on
 * dispose would wipe the *next* page's freshly-published line.
 *
 * A *group* is not a layer: the Veg layer reports as two of them
 * (`roadSituations`, `roadCameras`), because across the room those
 * answer different questions -- see `page-status.ts`'s
 * `LIVE_LAYER_GROUP_IDS`.
 */
export function mountLiveLayers(L: typeof Leaflet, map: Leaflet.Map, status: PageStatus): () => void {
    // Tearing a layer down makes it report one last time -- zero vessels,
    // no attribution -- and by then the shared slots may already belong to
    // the page sliding in behind this one. Publishing that final nothing
    // would blank its footer line. Nobody needs a count from a layer that
    // is going away, so teardown says nothing at all.
    let disposed = false;
    const counts: LayerCounts = emptyLayerCounts();
    const attributions = new Map<LiveLayerGroupId, string>();
    // Per-group, so one group's report never clobbers the other's share of
    // the single combined figure the masthead shows.
    const hiddenByAge = new Map<LiveLayerGroupId, number>();
    const items = new Map<LiveLayerGroupId, LiveLayerItem[]>();
    // Only `warnings` calls `reportColor` today (`LiveLayerCallbacks`'s own
    // doc comment on why it is optional) -- a plain object rather than a
    // `Map`, since `PageStatus.layerColors` takes the same partial-record
    // shape directly, with no conversion at publish time.
    const colors: LiveLayerColors = {};

    /**
     * Zoomed in far enough that the vessel fills the view rather than
     * being a dot in it, but not so far that the surrounding coastline
     * disappears and the position loses its context.
     */
    const FOCUS_ZOOM = 13;

    function publishListing(): void {
        if (disposed) return;
        // Built by walking the registry, so every group is present (empty
        // when its layer is off) and the masthead can index straight in.
        const byGroup = {} as Record<LiveLayerGroupId, LiveLayerItem[]>;
        for (const id of LIVE_LAYER_GROUP_IDS) byGroup[id] = items.get(id) ?? [];
        status.layerListing({
            items: byGroup,
            focus: (item: LiveLayerItem) => {
                map.setView([item.lat, item.lng], Math.max(map.getZoom(), FOCUS_ZOOM));
            },
        });
    }

    function reportItems(id: LiveLayerGroupId, next: readonly LiveLayerItem[]): void {
        if (disposed) return;
        items.set(id, [...next]);
        publishListing();
    }

    function reportCount(id: LiveLayerGroupId, count: number, hidden: number): void {
        if (disposed) return;
        counts[id] = count;
        hiddenByAge.set(id, hidden);
        counts.hiddenByAge = [...hiddenByAge.values()].reduce((total, value) => total + value, 0);
        status.layerCounts({ ...counts });
    }

    /** See `PageStatus.layerColors`'s doc comment -- currently `warnings` alone. */
    function reportColor(id: LiveLayerGroupId, color: string | null): void {
        if (disposed) return;
        colors[id] = color;
        status.layerColors({ ...colors });
    }

    /**
     * De-duplicated **by text**, not just by layer id: the roads layer's
     * situations and its road cameras (Phase D) are both "Data: Statens
     * vegvesen", and a footer naming the same operator twice reads as a
     * bug in the footer. A `Set` over the values keeps first-registered
     * order, which is the order the layers mount in.
     */
    function reportAttribution(id: LiveLayerGroupId, text: string | undefined): void {
        if (disposed) return;
        if (text === undefined) {
            attributions.delete(id);
        } else {
            attributions.set(id, text);
        }
        const unique = [...new Set(attributions.values())];
        status.attribution(unique.length === 0 ? null : unique.join(' · '));
    }

    status.layerCounts({ ...counts });
    status.layerColors({ ...colors });
    publishListing();

    const disposeFollowChip = mountFollowChip(L, map);

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

    const disposeRoads = registerMapLayer(map, (m) =>
        mountRoadsLayer(L, m, {
            reportCount: (count, hidden) => {
                reportCount('roadSituations', count, hidden);
            },
            reportAttribution: (text) => {
                reportAttribution('roadSituations', text);
            },
            reportItems: (next) => {
                reportItems('roadSituations', next);
            },
        }),
    );

    const disposeRoadCameras = registerMapLayer(map, (m) =>
        mountRoadCamerasLayer(L, m, {
            reportCount: (count, hidden) => {
                reportCount('roadCameras', count, hidden);
            },
            reportAttribution: (text) => {
                reportAttribution('roadCameras', text);
            },
            reportItems: (next) => {
                reportItems('roadCameras', next);
            },
        }),
    );

    const disposeTransit = registerMapLayer(map, (m) =>
        mountTransitLayer(L, m, {
            reportCount: (count, hidden) => {
                reportCount('transit', count, hidden);
            },
            reportAttribution: (text) => {
                reportAttribution('transit', text);
            },
            reportItems: (next) => {
                reportItems('transit', next);
            },
        }),
    );

    const disposeWarnings = registerMapLayer(map, (m) =>
        mountWarningsLayer(L, m, {
            reportCount: (count, hidden) => {
                reportCount('warnings', count, hidden);
            },
            reportAttribution: (text) => {
                reportAttribution('warnings', text);
            },
            reportItems: (next) => {
                reportItems('warnings', next);
            },
            reportColor: (color) => {
                reportColor('warnings', color);
            },
        }),
    );

    return function dispose(): void {
        disposed = true;
        // Before the layers, so the follow's own timer and map listener are
        // gone while the map it holds is still alive -- and because a
        // follow is a property of this page being open, never something to
        // resume on whatever page comes next. Releases the slideshow too.
        stopFollowing();
        disposeFollowChip();
        disposeShips();
        disposeAircraft();
        disposeRoads();
        disposeRoadCameras();
        disposeTransit();
        disposeWarnings();
    };
}
