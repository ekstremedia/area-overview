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
import type { LayerCounts, LiveLayerItem, PageStatus } from '../../shell/page-status.js';
import { mountAircraftLayer } from './aircraft.js';
import { followTarget, stopFollowing } from './follow.js';
import { mountShipsLayer } from './ships.js';

/** A layer's mount function: given the map, start whatever it needs and return its own disposer. */
export type MapLayerMount = (map: Leaflet.Map) => () => void;

/** Runs `mount` against `map` and hands back a disposer -- the smallest possible wrapper around a layer's own mount function. */
export function registerMapLayer(map: Leaflet.Map, mount: MapLayerMount): () => void {
    return mount(map);
}

type LayerId = keyof LayerCounts;

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
 * into the one `{ships, aircraft}` object the masthead reads, and their
 * individually-reported attribution strings into the one joined line the
 * footer reads. Clearing both again is `MapPage.ts`'s job, through its
 * `claimPageStatus()` release: the shell keeps the incoming page mounted
 * while the outgoing one is still on screen, so a slot cleared here on
 * dispose would wipe the *next* page's freshly-published line.
 */
export function mountLiveLayers(L: typeof Leaflet, map: Leaflet.Map, status: PageStatus): () => void {
    // Tearing a layer down makes it report one last time -- zero vessels,
    // no attribution -- and by then the shared slots may already belong to
    // the page sliding in behind this one. Publishing that final nothing
    // would blank its footer line. Nobody needs a count from a layer that
    // is going away, so teardown says nothing at all.
    let disposed = false;
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
        if (disposed) return;
        status.layerListing({
            ships: items.get('ships') ?? [],
            aircraft: items.get('aircraft') ?? [],
            focus: (item: LiveLayerItem) => {
                map.setView([item.lat, item.lng], Math.max(map.getZoom(), FOCUS_ZOOM));
            },
        });
    }

    function reportItems(id: LayerId, next: readonly LiveLayerItem[]): void {
        if (disposed) return;
        items.set(id, [...next]);
        publishListing();
    }

    function reportCount(id: LayerId, count: number, hidden: number): void {
        if (disposed) return;
        counts[id] = count;
        hiddenByAge.set(id, hidden);
        counts.hiddenByAge = [...hiddenByAge.values()].reduce((total, value) => total + value, 0);
        status.layerCounts({ ...counts });
    }

    function reportAttribution(id: LayerId, text: string | undefined): void {
        if (disposed) return;
        if (text === undefined) {
            attributions.delete(id);
        } else {
            attributions.set(id, text);
        }
        status.attribution(attributions.size === 0 ? null : [...attributions.values()].join(' · '));
    }

    status.layerCounts({ ...counts });
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
    };
}
