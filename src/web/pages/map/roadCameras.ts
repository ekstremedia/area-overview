/**
 * The Veg layer's road cameras: polls `GET /api/road-cameras?bbox=` for
 * the map's current viewport and drops one muted pin per *camera*.
 * Mounted only through `layers.ts`'s `mountLiveLayers`, alongside
 * `roads.ts` -- the two are siblings under one settings toggle, not one
 * module.
 *
 * Three things are deliberate here.
 *
 * **A fixed poll, not the user's.** `settings.roads.pollSeconds` (60-600)
 * drives road *situations*, where the answer changes. The camera roster
 * barely moves -- the same nineteen cameras stand in Vesterålen week
 * after week -- and the picture is refreshed browser-side by re-setting
 * `src` (`cameraModal.ts`), which costs the API nothing. So this polls on
 * its own `ROAD_CAMERAS_POLL_MS`, matching the BFF's own 300 s cache TTL:
 * asking more often than the cache can answer differently is pure noise.
 *
 * **A cluster is a site.** Cameras at one location share their
 * coordinates *exactly* (up to four orientations, `CAMERA_ID` is
 * `<siteId>_<n>`), so the generic `clustering.ts` groups them with no
 * site-specific code at all -- there is no "group by siteId" anywhere in
 * this file, and there should not be. The threshold is the same
 * tap-footprint one `ships.ts` uses, so two genuinely different sites
 * that are a finger apart on a zoomed-out map merge too; that is the
 * correct outcome for a touchscreen, and `cameraModal.ts`'s grid labels
 * every tile with its own site name so a mixed cluster still reads.
 *
 * **The pins are muted on purpose.** They share the map with the
 * situation signs from `roads.ts`, and a road being shut is the thing
 * that must be read across the room; a camera is something you go
 * looking for. Hence a plain glyph in `--color-muted`, no colour state,
 * no sign face.
 *
 * Diffed by camera id across polls (`setLatLng`), never rebuilt -- the
 * `markers.ts`/`roads.ts` pattern.
 */
import type * as Leaflet from 'leaflet';
import { ROADS_LAYER } from '../../../shared/layers.js';
import { RoadCamerasResponseSchema, type RoadCamera, type RoadCamerasResponse } from '../../../shared/schemas/road-cameras.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { resource } from '../../core/resource.js';
import { effect } from '../../core/signal.js';
import { t } from '../../i18n/index.js';
import { settings } from '../../settings-resource.js';
import { closeRoadCameraModal, openRoadCameraModal } from './cameraModal.js';
import { clusterPoints, type Cluster, type ClusterInputPoint } from './clustering.js';
import { mapToBboxQuery, mountWhileEnabled, refetchOnMapMove, type LiveLayerCallbacks } from './liveLayerMount.js';
import { formatRoadNumber } from './roadNumber.js';

/**
 * Fixed, and deliberately not `settings.roads.pollSeconds` -- see this
 * file's doc comment. Matches `ROAD_CAMERAS_CACHE_TTL_MS` on the BFF.
 */
export const ROAD_CAMERAS_POLL_MS = 300_000;

/** The full 44px tap-target minimum; the visible plate inside it is smaller (`map.css`), same as `road-pin` and the ship cluster badge. */
const ROAD_CAMERA_PIN_PX = 44;

/** Two pins whose tap targets (each `2 * 22px`) would overlap become one badge instead of competing for the same finger -- the same reasoning, and the same number, as `ships.ts`. */
const CLUSTER_THRESHOLD_PX = 44;

/**
 * A camera, drawn rather than vendored: unlike the situation pins this
 * is not a Vegvesen sign face (there is no traffic sign for "webcam"),
 * so there is no artwork to licence and nothing to attribute. `fill:
 * currentColor` keeps the colour in `map.css` with every other colour in
 * this app.
 */
const CAMERA_GLYPH = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9.2 4.5h5.6l1.1 2H20a1.8 1.8 0 0 1 1.8 1.8v9.4A1.8 1.8 0 0 1 20 19.5H4A1.8 1.8 0 0 1 2.2 17.7V8.3A1.8 1.8 0 0 1 4 6.5h4.1l1.1-2Zm2.8 4.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Zm0 1.9a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>`;

async function fetchRoadCameras(map: Leaflet.Map): Promise<Result<RoadCamerasResponse>> {
    // No usable viewport (see `mapToBboxQuery`). An error, not an empty
    // answer, so `resource` keeps the pins already drawn.
    const bbox = mapToBboxQuery(map);
    if (bbox === null) return err({ message: 'Skipped GET /api/road-cameras: the map has no measurable viewport yet' });
    try {
        const response = await fetch(`/api/road-cameras?bbox=${bbox}`);
        // No `{configured:false}` case here, unlike every other live
        // layer: the upstream is keyless, so this route has no
        // unconfigured state to report (see `RoadCamerasResponseSchema`).
        if (!response.ok) return err({ message: `GET /api/road-cameras responded ${String(response.status)}` });
        const json: unknown = await response.json();
        const parsed = RoadCamerasResponseSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/road-cameras returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/road-cameras', cause });
    }
}

function glyphElement(className: string): HTMLElement {
    const holder = document.createElement('span');
    holder.className = className;
    // A build-time constant, never anything that came off the wire.
    holder.innerHTML = CAMERA_GLYPH;
    holder.setAttribute('aria-hidden', 'true');
    return holder;
}

function buildCameraPinIcon(L: typeof Leaflet): Leaflet.DivIcon {
    const plate = document.createElement('span');
    plate.className = 'road-camera-pin-plate';
    plate.append(glyphElement('road-camera-pin-glyph'));
    return L.divIcon({
        className: 'road-camera-pin',
        html: plate,
        iconSize: [ROAD_CAMERA_PIN_PX, ROAD_CAMERA_PIN_PX],
        iconAnchor: [ROAD_CAMERA_PIN_PX / 2, ROAD_CAMERA_PIN_PX / 2],
    });
}

/** The same plate with a count beside the glyph: "this one tap opens several views". */
function buildCameraClusterIcon(L: typeof Leaflet, count: number): Leaflet.DivIcon {
    const plate = document.createElement('span');
    plate.className = 'road-camera-pin-plate road-camera-cluster-plate';
    plate.append(glyphElement('road-camera-pin-glyph'));
    const label = document.createElement('span');
    label.className = 'road-camera-cluster-count';
    label.textContent = String(count);
    plate.append(label);
    return L.divIcon({
        className: 'road-camera-pin',
        html: plate,
        iconSize: [ROAD_CAMERA_PIN_PX, ROAD_CAMERA_PIN_PX],
        iconAnchor: [ROAD_CAMERA_PIN_PX / 2, ROAD_CAMERA_PIN_PX / 2],
    });
}

/** Stable while membership is: a poll that changed nothing leaves the badge, and any open modal, exactly where they were. */
function clusterKeyOf(members: readonly RoadCamera[]): string {
    return members
        .map((camera) => camera.id)
        .sort()
        .join(',');
}

interface PinEntry {
    marker: Leaflet.Marker;
    camera: RoadCamera;
}

interface ClusterEntry {
    marker: Leaflet.Marker;
    members: RoadCamera[];
}

export function mountRoadCamerasLayer(L: typeof Leaflet, map: Leaflet.Map, callbacks: LiveLayerCallbacks): () => void {
    return mountWhileEnabled(
        // Both, and read inside `mountWhileEnabled`'s own effect: turning
        // the whole Veg layer off must take the cameras with it, and
        // "Vis vegkamera" must work without touching the layer toggle.
        () => settings.get().roads.enabled && settings.get().roads.showCameras,
        () => {
            const layerGroup = L.layerGroup().addTo(map);
            const pins = new Map<string, PinEntry>();
            const clusters = new Map<string, ClusterEntry>();
            let weatherBySite: RoadCamerasResponse['weatherBySite'] = {};
            let latestCameras: RoadCamera[] = [];

            function open(members: readonly RoadCamera[]): void {
                openRoadCameraModal({ cameras: members, weatherBySite });
            }

            function addPin(camera: RoadCamera): PinEntry {
                const marker = L.marker([camera.lat, camera.lng], { icon: buildCameraPinIcon(L) });
                marker.on('click', () => {
                    // Read through `pins` rather than closing over `camera`,
                    // so a pin created three polls ago opens what the last
                    // poll said about it.
                    open([pins.get(camera.id)?.camera ?? camera]);
                });
                marker.addTo(layerGroup);
                const entry: PinEntry = { marker, camera };
                pins.set(camera.id, entry);
                return entry;
            }

            function removePin(id: string): void {
                const entry = pins.get(id);
                if (!entry) return;
                layerGroup.removeLayer(entry.marker);
                pins.delete(id);
            }

            function addCluster(key: string, cluster: Cluster<RoadCamera>, at: Leaflet.LatLng): void {
                const marker = L.marker(at, { icon: buildCameraClusterIcon(L, cluster.members.length) });
                const entry: ClusterEntry = { marker, members: cluster.members };
                marker.on('click', () => {
                    open(entry.members);
                });
                marker.addTo(layerGroup);
                clusters.set(key, entry);
            }

            /**
             * Re-projects every camera at the map's *current* zoom and
             * splits the result: a one-member cluster is an ordinary pin,
             * anything larger is a badge. Called on every poll and on
             * `zoomend`, since screen-pixel distances move with zoom even
             * though the coordinates do not.
             */
            function render(): void {
                const zoom = map.getZoom();
                const points: ClusterInputPoint<RoadCamera>[] = latestCameras.map((camera) => {
                    const pixel = map.project(L.latLng(camera.lat, camera.lng), zoom);
                    return { id: camera.id, xPx: pixel.x, yPx: pixel.y, data: camera };
                });
                const grouped = clusterPoints(points, CLUSTER_THRESHOLD_PX);

                const wantedPins = new Set<string>();
                const wantedClusters = new Set<string>();
                for (const cluster of grouped) {
                    const [first] = cluster.members;
                    if (cluster.members.length === 1 && first) {
                        wantedPins.add(first.id);
                        const existing = pins.get(first.id);
                        if (existing) {
                            existing.camera = first;
                            existing.marker.setLatLng([first.lat, first.lng]);
                        } else {
                            addPin(first);
                        }
                        continue;
                    }
                    const key = clusterKeyOf(cluster.members);
                    wantedClusters.add(key);
                    const at = map.unproject(L.point(cluster.xPx, cluster.yPx), zoom);
                    const existing = clusters.get(key);
                    if (existing) {
                        existing.members = cluster.members;
                        existing.marker.setLatLng(at);
                    } else {
                        addCluster(key, cluster, at);
                    }
                }

                for (const id of [...pins.keys()]) if (!wantedPins.has(id)) removePin(id);
                for (const [key, entry] of [...clusters]) {
                    if (wantedClusters.has(key)) continue;
                    layerGroup.removeLayer(entry.marker);
                    clusters.delete(key);
                }

                // No age filter on this layer: a camera is either listed or
                // it is not, and a faulted one never leaves the BFF.
                callbacks.reportCount(latestCameras.length, 0);
                callbacks.reportItems(
                    latestCameras.map((camera) => ({
                        id: camera.id,
                        label: camera.name,
                        detail: camera.direction ?? formatRoadNumber(camera.roadNumber) ?? t('map.roadCameraLabel'),
                        lat: camera.lat,
                        lng: camera.lng,
                        // The one group whose masthead row does not pan the
                        // map: a camera *is* its picture, and panning to
                        // its pin would only ask the visitor to find and
                        // tap the pin themselves. Closing over `camera` is
                        // safe because this whole list is rebuilt on every
                        // `render()` -- unlike a pin, which outlives its
                        // poll and so reads through `pins` instead.
                        activate: (): void => {
                            open([camera]);
                        },
                    })),
                );
                callbacks.reportAttribution(ROADS_LAYER.attribution);
            }

            function clearAll(): void {
                for (const id of [...pins.keys()]) removePin(id);
                for (const [key, entry] of [...clusters]) {
                    layerGroup.removeLayer(entry.marker);
                    clusters.delete(key);
                }
            }

            const res = resource(() => fetchRoadCameras(map), { intervalMs: ROAD_CAMERAS_POLL_MS });

            const disposeEffect = effect(() => {
                const state = res.state.get();
                if (state.status !== 'ready') return;
                latestCameras = state.data.cameras;
                weatherBySite = state.data.weatherBySite;
                render();
            });

            function onZoomEnd(): void {
                if (latestCameras.length > 0) render();
            }
            map.on('zoomend', onZoomEnd);

            const disposeMoveRefetch = refetchOnMapMove(map, () => {
                res.refresh();
            });

            return function dispose(): void {
                disposeEffect();
                map.off('zoomend', onZoomEnd);
                disposeMoveRefetch();
                res.dispose();
                // Switching the layer off with a picture on screen has to
                // take the picture with it -- the modal is an overlay on
                // `document.body`, not a child of anything removed here.
                closeRoadCameraModal();
                clearAll();
                map.removeLayer(layerGroup);
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
            };
        },
    );
}
