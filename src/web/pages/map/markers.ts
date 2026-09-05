/**
 * Camera markers: which cameras get a pin (placed) vs. which don't
 * (unplaced), and how the pin set changes in place across camera-list/
 * placement updates without ever throwing the whole marker layer away.
 *
 * `markerData` is a `computed()` over both `camerasResource` and
 * `settings` (for `placements`), created once here at module scope --
 * per Phase 4's rule, a `computed()` has no disposal, so it must be a
 * long-lived module-scope value, never recreated inside `MapPage.ts`'s
 * per-mount `render()`. Placing/re-placing a camera (Phase 9, or the
 * `PUT /api/settings/placements/:id` route directly) is reflected here
 * with no page reload and no extra fetch beyond the existing camera/
 * settings polls.
 *
 * `computeMarkerData`/`diffMarkers` below are pure and Leaflet-free by
 * design, specifically so they can be unit-tested without a real Leaflet
 * map (see `markers.test.ts`). `createCameraMarkerLayer` is the only
 * Leaflet-touching part -- it takes the already-imported Leaflet
 * namespace as a parameter (see `tiles.ts`'s doc comment for why: no
 * static `import` of `leaflet` belongs in this file).
 */
import type * as Leaflet from 'leaflet';
import type { Camera } from '../../../shared/schemas/camera.js';
import type { Settings } from '../../../shared/schemas/settings.js';
import { computed, effect, type ReadonlySignal } from '../../core/signal.js';
import { camerasResource } from '../../camera-resource.js';
import { settings } from '../../settings-resource.js';

export interface MarkerDescriptor {
    cameraId: string;
    camera: Camera;
    lat: number;
    lng: number;
}

export interface MarkerData {
    placed: MarkerDescriptor[];
    unplaced: Camera[];
}

/** A camera with no entry in `placements` is skipped on the map and collected into `unplaced` instead (for the "N cameras without placement" link). */
export function computeMarkerData(cameras: readonly Camera[], placements: Settings['placements']): MarkerData {
    const placed: MarkerDescriptor[] = [];
    const unplaced: Camera[] = [];
    for (const camera of cameras) {
        const placement = placements[camera.camera_id];
        if (placement) {
            placed.push({ cameraId: camera.camera_id, camera, lat: placement.lat, lng: placement.lng });
        } else {
            unplaced.push(camera);
        }
    }
    return { placed, unplaced };
}

export interface MarkerDiff {
    toAdd: MarkerDescriptor[];
    toUpdate: MarkerDescriptor[];
    toRemove: string[];
}

/** The fields that matter for what a marker/popup actually shows -- two descriptors that agree on all of these render identically, even if the `Camera` object is a new reference from a fresh poll. */
function markerDataEqual(a: MarkerDescriptor, b: MarkerDescriptor): boolean {
    return (
        a.lat === b.lat &&
        a.lng === b.lng &&
        a.camera.name === b.camera.name &&
        a.camera.description === b.camera.description &&
        a.camera.location === b.camera.location &&
        a.camera.current_image_url === b.camera.current_image_url &&
        a.camera.current_image_updated_at === b.camera.current_image_updated_at
    );
}

/**
 * Diffs a previous marker-descriptor set against the next one, by
 * `cameraId`. Pure data in, pure data out -- no Leaflet, no DOM -- so a
 * poll that changes nothing produces an empty diff, and a placement
 * change produces exactly one `toUpdate` entry, never a full rebuild.
 */
export function diffMarkers(previous: ReadonlyMap<string, MarkerDescriptor>, next: readonly MarkerDescriptor[]): MarkerDiff {
    const nextIds = new Set(next.map((descriptor) => descriptor.cameraId));
    const toAdd: MarkerDescriptor[] = [];
    const toUpdate: MarkerDescriptor[] = [];
    for (const descriptor of next) {
        const existing = previous.get(descriptor.cameraId);
        if (!existing) {
            toAdd.push(descriptor);
        } else if (!markerDataEqual(existing, descriptor)) {
            toUpdate.push(descriptor);
        }
    }
    const toRemove = [...previous.keys()].filter((id) => !nextIds.has(id));
    return { toAdd, toUpdate, toRemove };
}

/** Long-lived, module-scope derived marker data -- see this file's doc comment for why it must not be recreated per mount. */
export const markerData: ReadonlySignal<MarkerData> = computed(() => {
    const state = camerasResource.state.get();
    const cameras = state.status === 'ready' ? state.data.cameras : state.status === 'error' ? (state.lastData?.cameras ?? []) : [];
    return computeMarkerData(cameras, settings.get().placements);
});

/** The 20px paper-dot/ink-ring/halo pin from artboard 01 -- see `map.css` for the actual rule (token-based, no raw hex here). There is no "offline" pin variant in this phase: every placed camera renders identically. */
function cameraPinIcon(L: typeof Leaflet): Leaflet.DivIcon {
    return L.divIcon({ className: 'camera-pin', iconSize: [20, 20], iconAnchor: [10, 10] });
}

export interface CameraMarkerLayer {
    dispose(): void;
}

/**
 * Mounts the reactive camera-marker layer onto `map`. Markers are updated
 * in place (`setLatLng`/`setPopupContent`), never recreated wholesale, so
 * a 30s camera-list poll never glitches the map or resets the user's pan/
 * zoom. DOM/Leaflet writes from a single poll are batched into one
 * `requestAnimationFrame` rather than applied synchronously inside the
 * reactive `effect()` callback.
 */
export function createCameraMarkerLayer(L: typeof Leaflet, map: Leaflet.Map, buildPopupContent: (camera: Camera) => HTMLElement): CameraMarkerLayer {
    const layerGroup = L.layerGroup().addTo(map);
    const markersById = new Map<string, Leaflet.Marker>();
    const descriptorsById = new Map<string, MarkerDescriptor>();

    let pending: MarkerData | undefined;
    let rafHandle: ReturnType<typeof requestAnimationFrame> | undefined;

    function applyDiff(data: MarkerData): void {
        const diff = diffMarkers(descriptorsById, data.placed);

        for (const descriptor of diff.toAdd) {
            const marker = L.marker([descriptor.lat, descriptor.lng], { icon: cameraPinIcon(L) });
            marker.bindPopup(() => buildPopupContent(descriptorsById.get(descriptor.cameraId)?.camera ?? descriptor.camera), {
                className: 'camera-popup-wrapper',
                closeButton: false,
                maxWidth: 328,
                minWidth: 328,
                autoPanPadding: [20, 20],
            });
            marker.addTo(layerGroup);
            markersById.set(descriptor.cameraId, marker);
            descriptorsById.set(descriptor.cameraId, descriptor);
        }

        for (const descriptor of diff.toUpdate) {
            const marker = markersById.get(descriptor.cameraId);
            descriptorsById.set(descriptor.cameraId, descriptor);
            if (!marker) continue;
            marker.setLatLng([descriptor.lat, descriptor.lng]);
            if (marker.isPopupOpen()) marker.setPopupContent(buildPopupContent(descriptor.camera));
        }

        for (const cameraId of diff.toRemove) {
            const marker = markersById.get(cameraId);
            if (marker) layerGroup.removeLayer(marker);
            markersById.delete(cameraId);
            descriptorsById.delete(cameraId);
        }
    }

    function flush(): void {
        rafHandle = undefined;
        if (pending) applyDiff(pending);
        pending = undefined;
    }

    function scheduleSync(data: MarkerData): void {
        pending = data;
        if (rafHandle !== undefined) return;
        rafHandle = requestAnimationFrame(flush);
    }

    const disposeEffect = effect(() => {
        scheduleSync(markerData.get());
    });

    return {
        dispose(): void {
            disposeEffect();
            if (rafHandle !== undefined) cancelAnimationFrame(rafHandle);
            map.removeLayer(layerGroup);
            markersById.clear();
            descriptorsById.clear();
        },
    };
}
