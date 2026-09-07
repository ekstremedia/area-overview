/**
 * The ships (BarentsWatch AIS) live layer: polls `GET /api/ships?bbox=`
 * for the map's current viewport, renders each ship as a heading-rotated
 * triangle via `canvasGlyphLayer.ts` (cyan by default, green when its AIS
 * `navigationalStatus` is `0`/"under way using engine" -- see
 * `liveLayerColors.ts`), and reports its on-screen count/attribution
 * through `callbacks` for the masthead/footer. Mounted only through
 * `layers.ts`'s `mountLiveLayers` -- `MapPage.ts` never imports this file
 * directly.
 *
 * Ships whose on-screen projected positions land within
 * `CLUSTER_THRESHOLD_PX` of each other (`clustering.ts`'s pure geometry,
 * ships-only per Terje's ask -- aircraft never clusters) are pulled out
 * of the normal triangle rendering and rendered instead as a single
 * numbered badge (an `L.Marker`/`L.divIcon`, the same "circle marker"
 * mechanism `markers.ts`'s camera pins already use, not a third pattern).
 * A badge with any underway member (`navigationalStatus === 0`) gets a
 * green ring (`buildClusterIcon`'s `hasUnderway`) -- otherwise the per-ship
 * green/label the canvas layer draws for an individual underway ship would
 * be invisible whenever that ship happens to be clustered, which in
 * practice is most of the time.
 *
 * Tapping a badge opens a popup listing its members; tapping a member
 * swaps that same popup's content to `buildShipPopup`'s existing full
 * detail view, with a "back" affordance to return to the list -- see
 * `renderClusterPopup`'s doc comment for the state machine and its
 * deliberate simplification around membership changes.
 */
import type * as Leaflet from 'leaflet';
import { SHIPS_LAYER } from '../../../shared/layers.js';
import { ShipsResponseSchema, type Ship, type ShipsResponse } from '../../../shared/schemas/ships.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { resource } from '../../core/resource.js';
import { effect } from '../../core/signal.js';
import { formatNumber, t } from '../../i18n/index.js';
import { settings } from '../../settings-resource.js';
import { formatAge } from '../../shell/staleness.js';
import { createCanvasGlyphLayer } from './canvasGlyphLayer.js';
import { clusterPoints, type Cluster, type ClusterInputPoint } from './clustering.js';
import { visibleGlyphs, type GlyphDescriptor } from './glyphs.js';
import { SHIP_GLYPH_COLOR, SHIP_GLYPH_COLOR_UNDERWAY_ENGINE } from './liveLayerColors.js';
import { mapToBboxQuery, mountWhileEnabled, type LiveLayerCallbacks } from './liveLayerMount.js';

const SHIP_WIDTH_PX = 14;
const SHIP_HEIGHT_PX = 19;
const HIT_RADIUS_PX = 22; // half of a 44px tap diameter

/** Two ships whose tap targets (each `2 * HIT_RADIUS_PX` wide) would overlap cluster into one badge instead of competing for the same tap. */
const CLUSTER_THRESHOLD_PX = 2 * HIT_RADIUS_PX;

/** The clickable footprint of a cluster badge -- `--tap-min` (44px), same tap-target minimum as every other interactive element in this app. The visible circle inside it is smaller; see `map.css`. */
const CLUSTER_BADGE_ICON_PX = 44;

/** ITU-R M.1371 AIS navigational status `0` -- see `liveLayerColors.ts`'s doc comment for the colour this drives. */
const NAVIGATIONAL_STATUS_UNDERWAY_USING_ENGINE = 0;

function shipColor(ship: Ship): string {
    return ship.navigationalStatus === NAVIGATIONAL_STATUS_UNDERWAY_USING_ENGINE ? SHIP_GLYPH_COLOR_UNDERWAY_ENGINE : SHIP_GLYPH_COLOR;
}

/** `true` for the same `navigationalStatus === 0` subset `shipColor`/the per-ship label already single out -- shared by the cluster-badge indicator and the cluster list popup's per-row colouring below, both additive to the existing per-ship behaviour, not a replacement for it. */
function isUnderway(ship: Ship): boolean {
    return ship.navigationalStatus === NAVIGATIONAL_STATUS_UNDERWAY_USING_ENGINE;
}

/** The CSS custom property name the underway-green (`SHIP_GLYPH_COLOR_UNDERWAY_ENGINE`) is threaded through into `map.css`'s cluster-badge/list-row rules -- set as an inline style on the same element that consumes it via `var()`, the same "colour comes from JS, shape comes from CSS" split `canvasGlyphLayer.ts` already uses for the per-ship triangles, since divIcon/popup content is real DOM (unlike the canvas glyphs) and so *can* resolve a custom property, just not one that lives only in `tokens.css` (this green isn't a design token -- see `liveLayerColors.ts`'s doc comment). */
const UNDERWAY_COLOR_PROPERTY = '--ship-cluster-underway-color';

/** A ship's name for its always-visible label -- falls back to `map.shipUnknown`, same convention as `buildShipPopup`/`buildClusterListPopup`, rather than showing a blank tag next to the triangle. Only called for underway ships (`ships.ts`'s `mountShipsLayer`'s `labelFor`) -- moored/anchored/fishing ships get no label at all, to avoid cluttering the map. */
function shipLabel(ship: Ship): string {
    const name = ship.name.trim();
    return name === '' ? t('map.shipUnknown') : name;
}

async function fetchShips(map: Leaflet.Map): Promise<Result<ShipsResponse>> {
    try {
        const response = await fetch(`/api/ships?bbox=${mapToBboxQuery(map)}`);
        // 503 is the documented "unconfigured" response, not a failure --
        // parse and pass its {configured:false} body through like any
        // other status here (`response.ok` is false for a 503, so a
        // narrower `!response.ok` check would misclassify it as a
        // network/upstream error, hiding a well-formed, valid response).
        if (!response.ok && response.status !== 503) {
            return err({ message: `GET /api/ships responded ${String(response.status)}` });
        }
        const json: unknown = await response.json();
        const parsed = ShipsResponseSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/ships returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/ships', cause });
    }
}

function toGlyph(ship: Ship): GlyphDescriptor<Ship> {
    return {
        id: ship.mmsi,
        lat: ship.lat,
        lng: ship.lng,
        heading: ship.heading ?? ship.courseOverGround,
        timestamp: ship.timestamp,
        data: ship,
    };
}

function buildShipPopup(ship: Ship, now: Date = new Date()): HTMLElement {
    const root = document.createElement('div');
    root.className = 'ship-popup';

    const name = document.createElement('div');
    name.className = 'ship-popup-name';
    name.textContent = ship.name.trim() === '' ? t('map.shipUnknown') : ship.name;
    root.append(name);

    const mmsi = document.createElement('div');
    mmsi.textContent = t('map.shipMmsi', { mmsi: ship.mmsi });
    root.append(mmsi);

    const speed = document.createElement('div');
    speed.textContent = t('map.shipSpeed', { speed: formatNumber(ship.speedOverGround, t('unit.knots')) });
    root.append(speed);

    const course = document.createElement('div');
    course.textContent = t('map.shipCourse', { course: formatNumber(ship.courseOverGround, t('unit.degrees')) });
    root.append(course);

    const type = document.createElement('div');
    type.textContent = ship.shipType === null ? t('map.shipUnknownType') : t('map.shipType', { type: ship.shipType });
    root.append(type);

    const age = document.createElement('div');
    age.textContent = t('map.popupUpdated', { age: formatAge(new Date(ship.timestamp), now) });
    root.append(age);

    return root;
}

/** One tappable row per member ship in a cluster's list view -- name (falling back to `map.shipUnknown`, same convention as `buildShipPopup`) plus speed for a little context, `--tap-min`-tall per `map.css`. */
function buildClusterListPopup(members: readonly Ship[], onSelect: (mmsi: string) => void): HTMLElement {
    const root = document.createElement('div');
    root.className = 'ship-cluster-popup';

    const heading = document.createElement('div');
    heading.className = 'ship-cluster-popup-heading';
    heading.textContent = t('map.shipClusterCount', { count: members.length });
    root.append(heading);

    const list = document.createElement('div');
    list.className = 'ship-cluster-popup-list';
    for (const ship of members) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ship-cluster-popup-row';

        const name = document.createElement('span');
        name.className = 'ship-cluster-popup-row-name';
        name.textContent = ship.name.trim() === '' ? t('map.shipUnknown') : ship.name;
        if (isUnderway(ship)) {
            name.classList.add('ship-cluster-popup-row-name-underway');
            name.style.setProperty(UNDERWAY_COLOR_PROPERTY, SHIP_GLYPH_COLOR_UNDERWAY_ENGINE);
        }
        row.append(name);

        const meta = document.createElement('span');
        meta.className = 'ship-cluster-popup-row-meta';
        meta.textContent = t('map.shipSpeed', { speed: formatNumber(ship.speedOverGround, t('unit.knots')) });
        row.append(meta);

        row.addEventListener('click', () => {
            onSelect(ship.mmsi);
        });
        list.append(row);
    }
    root.append(list);

    return root;
}

/** A cluster member's full detail -- `buildShipPopup` reused unchanged, plus a "back to list" affordance above it since a cluster tap is likely to be revisited for another member. */
function buildClusterDetailPopup(ship: Ship, onBack: () => void): HTMLElement {
    const root = document.createElement('div');
    root.className = 'ship-cluster-popup ship-cluster-popup-detail';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'ship-cluster-popup-back';
    back.textContent = t('map.shipClusterBack');
    back.addEventListener('click', () => {
        onBack();
    });
    root.append(back);
    root.append(buildShipPopup(ship));

    return root;
}

/**
 * A numbered badge -- an `L.divIcon` (this codebase's one existing "circle
 * marker" convention, see `markers.ts`'s camera pins) sized to the app's
 * `--tap-min` footprint, with a smaller visible circle centered inside it
 * (`map.css`). `hasUnderway` (any member with `navigationalStatus === 0`,
 * see `clusterHasUnderway`) adds a green ring around that circle -- the
 * only glanceable, no-tap signal that a cluster contains a moving ship,
 * since the per-ship colour/label the canvas layer already draws for an
 * individual underway ship never appears once it's absorbed into a badge.
 */
function buildClusterIcon(L: typeof Leaflet, count: number, hasUnderway: boolean): Leaflet.DivIcon {
    const label = document.createElement('span');
    label.className = hasUnderway ? 'ship-cluster-badge-count ship-cluster-badge-count-underway' : 'ship-cluster-badge-count';
    label.textContent = String(count);
    if (hasUnderway) {
        label.style.setProperty(UNDERWAY_COLOR_PROPERTY, SHIP_GLYPH_COLOR_UNDERWAY_ENGINE);
    }
    return L.divIcon({
        className: 'ship-cluster-badge',
        html: label,
        iconSize: [CLUSTER_BADGE_ICON_PX, CLUSTER_BADGE_ICON_PX],
        iconAnchor: [CLUSTER_BADGE_ICON_PX / 2, CLUSTER_BADGE_ICON_PX / 2],
    });
}

/** `true` when at least one member of the cluster is underway (`isUnderway`) -- the badge's at-a-glance indicator is "any", not "all", since even one moving ship among several moored ones is the signal Terje asked for. */
function clusterHasUnderway(members: readonly Ship[]): boolean {
    return members.some(isUnderway);
}

function clusterKeyOf(members: readonly Ship[]): string {
    return members
        .map((ship) => ship.mmsi)
        .sort()
        .join(',');
}

function clusterCentroidLatLng(L: typeof Leaflet, map: Leaflet.Map, cluster: Cluster<Ship>): Leaflet.LatLng {
    return map.unproject(L.point(cluster.xPx, cluster.yPx), map.getZoom());
}

interface ClusterPopupState {
    mode: 'list' | 'detail';
    selectedMmsi: string | undefined;
    members: Ship[];
}

/**
 * Renders whichever half of the list/detail popup `state` is currently in
 * -- list by default, detail once a row was tapped. If the previously
 * selected ship is no longer among `state.members` (a poll dropped it, or
 * the cluster's own membership shifted since the popup was opened), this
 * falls back to the list view rather than showing stale/missing-ship
 * detail; `refresh` re-invokes this against the marker's live popup via
 * `setPopupContent` whenever `state` changes (a row/back tap, or a fresh
 * poll while the popup is open).
 */
function renderClusterPopup(state: ClusterPopupState, refresh: () => void): HTMLElement {
    if (state.mode === 'detail' && state.selectedMmsi !== undefined) {
        const ship = state.members.find((member) => member.mmsi === state.selectedMmsi);
        if (ship) {
            return buildClusterDetailPopup(ship, () => {
                state.mode = 'list';
                state.selectedMmsi = undefined;
                refresh();
            });
        }
        state.mode = 'list';
        state.selectedMmsi = undefined;
    }
    return buildClusterListPopup(state.members, (mmsi) => {
        state.mode = 'detail';
        state.selectedMmsi = mmsi;
        refresh();
    });
}

interface ClusterBadgeEntry {
    marker: Leaflet.Marker;
    state: ClusterPopupState;
    refresh: () => void;
}

function createClusterEntry(L: typeof Leaflet, map: Leaflet.Map, cluster: Cluster<Ship>): ClusterBadgeEntry {
    const state: ClusterPopupState = { mode: 'list', selectedMmsi: undefined, members: cluster.members };
    const marker = L.marker(clusterCentroidLatLng(L, map, cluster), {
        icon: buildClusterIcon(L, cluster.members.length, clusterHasUnderway(cluster.members)),
    });
    function refresh(): void {
        marker.setPopupContent(renderClusterPopup(state, refresh));
    }
    marker.bindPopup(() => renderClusterPopup(state, refresh), {
        className: 'live-glyph-popup-wrapper',
        autoPanPadding: [20, 20],
    });
    return { marker, state, refresh };
}

/**
 * Owns every cluster badge marker, keyed by `clusterKeyOf` (the sorted,
 * joined member MMSIs) -- stable across polls as long as membership
 * doesn't change, so an open list/detail popup survives an ordinary
 * refresh. A membership change (a ship joins/leaves/ages out) changes the
 * key, so `update` removes the old marker (closing any popup it had open,
 * never leaving a stale list referencing ships that no longer exist) and
 * creates a fresh one -- seamless continuity across a membership change
 * was not attempted, only "never stale". `buildClusterIcon`'s underway
 * indicator (`clusterHasUnderway`) is recomputed unconditionally on every
 * `update` call for an existing entry too, the same lifecycle point the
 * member count already uses -- so a member mooring/getting underway
 * between polls updates the badge even when membership itself (and so the
 * key) doesn't change.
 */
function createClusterBadgeLayer(L: typeof Leaflet, map: Leaflet.Map): { update(clusters: readonly Cluster<Ship>[]): void; dispose(): void } {
    const layerGroup = L.layerGroup().addTo(map);
    const entries = new Map<string, ClusterBadgeEntry>();

    function update(clusters: readonly Cluster<Ship>[]): void {
        const nextKeys = new Set<string>();
        for (const cluster of clusters) {
            const key = clusterKeyOf(cluster.members);
            nextKeys.add(key);
            const existing = entries.get(key);
            if (existing) {
                existing.state.members = cluster.members;
                existing.marker.setLatLng(clusterCentroidLatLng(L, map, cluster));
                existing.marker.setIcon(buildClusterIcon(L, cluster.members.length, clusterHasUnderway(cluster.members)));
                if (existing.marker.isPopupOpen()) existing.refresh();
            } else {
                const entry = createClusterEntry(L, map, cluster);
                entry.marker.addTo(layerGroup);
                entries.set(key, entry);
            }
        }
        for (const [key, entry] of entries) {
            if (nextKeys.has(key)) continue;
            layerGroup.removeLayer(entry.marker);
            entries.delete(key);
        }
    }

    return {
        update,
        dispose(): void {
            map.removeLayer(layerGroup);
            entries.clear();
        },
    };
}

export function mountShipsLayer(L: typeof Leaflet, map: Leaflet.Map, callbacks: LiveLayerCallbacks): () => void {
    return mountWhileEnabled(
        () => settings.get().ships.enabled,
        () => {
            const canvasLayer = createCanvasGlyphLayer<Ship>(L, map, {
                color: SHIP_GLYPH_COLOR,
                widthPx: SHIP_WIDTH_PX,
                heightPx: SHIP_HEIGHT_PX,
                hitRadiusPx: HIT_RADIUS_PX,
                buildPopup: (ship) => buildShipPopup(ship),
                colorFor: shipColor,
                // Only ships under way using their engine get a label --
                // Terje's ask was specifically the green/underway subset
                // just coloured by the previous feature, not every ship,
                // to avoid cluttering the map with moored/anchored/fishing
                // vessels' names.
                labelFor: (ship) => (ship.navigationalStatus === NAVIGATIONAL_STATUS_UNDERWAY_USING_ENGINE ? shipLabel(ship) : null),
            });
            const clusterBadges = createClusterBadgeLayer(L, map);

            const pollSeconds = Math.max(settings.get().ships.pollSeconds, SHIPS_LAYER.minPollSeconds);
            const res = resource(() => fetchShips(map), { intervalMs: pollSeconds * 1000 });

            let latestShips: Ship[] = [];
            let latestConfigured = false;

            /**
             * Re-projects every visible ship at the map's *current* zoom,
             * clusters them (`CLUSTER_THRESHOLD_PX`), and splits the
             * result: single-member clusters go to `canvasLayer` as
             * ordinary triangles, multi-member ones become/stay a cluster
             * badge. Called on every poll and on `zoomend` (screen-pixel
             * distances shift with zoom even though lat/lng doesn't).
             */
            function render(): void {
                const maxAgeMinutes = settings.get().ships.maxAgeMinutes;
                const now = new Date();
                const visible = visibleGlyphs(latestShips.map(toGlyph), maxAgeMinutes, now);
                const zoom = map.getZoom();
                const points: ClusterInputPoint<GlyphDescriptor<Ship>>[] = visible.map(({ descriptor }) => {
                    const pixel = map.project(L.latLng(descriptor.lat, descriptor.lng), zoom);
                    return { id: descriptor.id, xPx: pixel.x, yPx: pixel.y, data: descriptor };
                });
                const clusters = clusterPoints(points, CLUSTER_THRESHOLD_PX);

                const singleDescriptors: GlyphDescriptor<Ship>[] = [];
                const groupClusters: Cluster<Ship>[] = [];
                for (const cluster of clusters) {
                    if (cluster.members.length === 1) {
                        const [descriptor] = cluster.members;
                        if (descriptor) singleDescriptors.push(descriptor);
                    } else {
                        groupClusters.push({ id: cluster.id, xPx: cluster.xPx, yPx: cluster.yPx, members: cluster.members.map((d) => d.data) });
                    }
                }

                canvasLayer.update(singleDescriptors, maxAgeMinutes, now);
                clusterBadges.update(groupClusters);
                callbacks.reportCount(visible.length);
                callbacks.reportAttribution(SHIPS_LAYER.attribution);
            }

            function clear(): void {
                latestShips = [];
                latestConfigured = false;
                canvasLayer.update([], settings.get().ships.maxAgeMinutes, new Date());
                clusterBadges.update([]);
                callbacks.reportCount(0);
                callbacks.reportAttribution(undefined);
            }

            function onZoomEnd(): void {
                if (latestConfigured) render();
            }
            map.on('zoomend', onZoomEnd);

            const disposeEffect = effect(() => {
                const state = res.state.get();
                if (state.status !== 'ready') return;
                if (!state.data.configured) {
                    clear();
                    return;
                }
                latestConfigured = true;
                latestShips = state.data.ships;
                render();
            });

            return function dispose(): void {
                disposeEffect();
                map.off('zoomend', onZoomEnd);
                res.dispose();
                canvasLayer.dispose();
                clusterBadges.dispose();
                callbacks.reportCount(0);
                callbacks.reportAttribution(undefined);
            };
        },
    );
}
