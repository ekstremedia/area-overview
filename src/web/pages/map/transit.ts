/**
 * The Transit (Entur) live layer: polls `GET /api/transit?bbox=&maxAgeMinutes=`
 * for the map's current viewport and draws one pin per bus/ferry position
 * fix. Mounted only through `layers.ts`'s `mountLiveLayers`.
 *
 * Like `roads.ts` and unlike `ships.ts`/`aircraft.ts`, this is pins, not
 * canvas glyphs: a bus pin carries real text (its `publicCode`), which has
 * to be DOM (`L.divIcon`) for `map.css` to size and style it, and a vehicle
 * here carries no `bearing` at all (unlike a ship's heading), so there is
 * no rotation to justify a canvas triangle either. Every fix is diffed by
 * `id` across polls (`setLatLng`/`setIcon`, popup content refreshed while
 * open), never rebuilt -- the same reasoning `roads.ts`'s doc comment
 * gives for its own situations.
 *
 * Unlike every other live layer's `maxAgeMinutes`, this one is **not**
 * applied client-side: `GET /api/transit`'s own `maxAgeMinutes` query
 * parameter asks the BFF to drop stale fixes before they are ever sent
 * (`routes/transit.ts`'s doc comment), so every vehicle this module
 * receives is already within bounds. That is also why `reportCount`'s
 * second argument -- vessels/aircraft hidden by age -- is always `0` here:
 * a fix dropped for being stale never reaches the client to be counted, in
 * the same way `roads.ts` always reports `0` for a layer with no age
 * filter at all.
 *
 * `showBuses`/`showFerries` are the client-side mode filters (mirrors
 * `roads.ts`'s `showPlanned`/`showCameras`): the response carries both
 * modes in one bbox query, so filtering here costs no extra request and
 * re-filters what is already on screen the instant either setting flips.
 *
 * Ferry pins draw above the ships layer's own glyphs with no pane or
 * `zIndexOffset` work needed: ships are canvas paths in Leaflet's default
 * `overlayPane` (`canvasGlyphLayer.ts`'s `sharedCanvasRenderer`, z-index
 * 400), while an `L.marker` with no explicit `pane` option -- what
 * `addEntry` below creates, the same as `roads.ts`'s pins -- lands in the
 * default `markerPane` (z-index 600), already above it.
 */
import type * as Leaflet from 'leaflet';
import { TRANSIT_LAYER } from '../../../shared/layers.js';
import { TransitResponseSchema, type TransitMode, type TransitResponse, type TransitVehicle } from '../../../shared/schemas/transit.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { effect } from '../../core/signal.js';
import { formatNumber, t } from '../../i18n/index.js';
import { settings } from '../../settings-resource.js';
import { formatAge } from '../../shell/staleness.js';
import { TRANSIT_LATE_COLOR, TRANSIT_ON_TIME_COLOR } from './liveLayerColors.js';
import { mapToBboxQuery, mountWhileEnabled, refetchOnMapMove, resourceWithDynamicInterval, type LiveLayerCallbacks } from './liveLayerMount.js';
/*
 * Original artwork for this project, not vendored -- see
 * `glyphs/README.md` for why that distinction matters here (unlike
 * `roads.ts`'s `signs/*.svg`, which *are* vendored and licensed
 * separately).
 */
import busGlyph from './glyphs/bus.svg?raw';
import ferryGlyph from './glyphs/ferry.svg?raw';

/** The full 44px tap-target minimum, same arrangement as `roads.ts`'s `ROAD_PIN_PX`. */
const TRANSIT_PIN_PX = 44;

/** The CSS custom property `map.css`'s pin rules read the punctuality colour from -- same "colour from JS, shape from CSS" split `ROAD_COLOR_PROPERTY` uses. */
const TRANSIT_COLOR_PROPERTY = '--transit-vehicle-color';

/**
 * A delay beyond which a late vehicle is more than three minutes behind,
 * which is when the pin itself takes the late tint. Between one and three
 * minutes late the popup already says so in words (`punctualityFor`
 * returns `'late'` from 61s on), but the pin stays on-time-coloured: a bus
 * running two minutes behind is not the fact a passer-by needs flagged
 * from across the room, only one someone waiting for it needs to read in
 * the popup.
 */
const LATE_TINT_THRESHOLD_SECONDS = 180;

/** A delay this small either way is measurement noise on a GPS fix, not lateness -- the same "on time" band a passenger reads at a stop. */
const ON_TIME_BAND_SECONDS = 60;

export type PunctualityKind = 'onTime' | 'late' | 'early' | 'unknown';

export interface PunctualityResult {
    kind: PunctualityKind;
    /** Minutes late/early, rounded to the nearest whole minute. Present only for `'late'`/`'early'`. */
    minutes?: number;
}

/**
 * The three-way punctuality word this layer's pin colour and popup text
 * are both built from, exhaustively bounded (see `transit.test.ts`):
 *
 *  - `Math.abs(delaySeconds) <= 60` -- "on time";
 *  - `delaySeconds < -60` -- "early", by however many minutes;
 *  - anything else positive -- "late", by however many minutes (from 61s
 *    on; whether that lateness is enough to *tint the pin* is
 *    `isLateEnoughToTint`'s separate, stricter question);
 *  - `null` (upstream gave no estimate for this fix) -- "unknown", no
 *    phrase shown, no data to judge lateness by.
 *
 * Pure and Leaflet-free on purpose, same as `glyphs.ts`'s age/opacity
 * math: this is the one piece of this layer's logic worth testing without
 * a fake map.
 */
export function punctualityFor(delaySeconds: number | null): PunctualityResult {
    if (delaySeconds === null) return { kind: 'unknown' };
    if (Math.abs(delaySeconds) <= ON_TIME_BAND_SECONDS) return { kind: 'onTime' };
    if (delaySeconds < -ON_TIME_BAND_SECONDS) return { kind: 'early', minutes: Math.round(-delaySeconds / 60) };
    return { kind: 'late', minutes: Math.round(delaySeconds / 60) };
}

/**
 * Whether a vehicle's lateness is enough to tint its pin -- stricter than
 * `punctualityFor`'s own `'late'` kind (which starts at 61s): only past
 * `LATE_TINT_THRESHOLD_SECONDS` does the map itself flag it, so a pin
 * changing colour always means "more than three minutes behind", never
 * "a GPS fix rounded oddly".
 */
export function isLateEnoughToTint(delaySeconds: number | null): boolean {
    return delaySeconds !== null && delaySeconds > LATE_TINT_THRESHOLD_SECONDS;
}

function colorFor(vehicle: TransitVehicle): string {
    return isLateEnoughToTint(vehicle.delaySeconds) ? TRANSIT_LATE_COLOR : TRANSIT_ON_TIME_COLOR;
}

function punctualityText(delaySeconds: number | null): string | null {
    const result = punctualityFor(delaySeconds);
    switch (result.kind) {
        case 'unknown':
            return null;
        case 'onTime':
            return t('map.transitOnTime');
        case 'late':
            return t('map.transitLate', { minutes: formatNumber(result.minutes ?? 0) });
        case 'early':
            return t('map.transitEarly', { minutes: formatNumber(result.minutes ?? 0) });
    }
}

const MODE_LABEL_KEYS: Readonly<Record<TransitMode, 'map.transitModeBus' | 'map.transitModeFerry'>> = {
    bus: 'map.transitModeBus',
    ferry: 'map.transitModeFerry',
};

const MODE_GLYPHS: Readonly<Record<TransitMode, string>> = {
    bus: busGlyph,
    ferry: ferryGlyph,
};

async function fetchTransit(map: Leaflet.Map): Promise<Result<TransitResponse>> {
    // No usable viewport (see `mapToBboxQuery`).
    const bbox = mapToBboxQuery(map);
    if (bbox === null) return err({ message: 'Skipped GET /api/transit: the map has no measurable viewport yet' });
    // Read fresh on every poll, not captured once at mount -- a
    // `settings.transit.maxAgeMinutes` change takes effect on the next
    // poll, the same way a `pollSeconds` change already does for every
    // live layer (see `mountTransitLayer`'s own comment on `pollSeconds`).
    const maxAgeMinutes = settings.get().transit.maxAgeMinutes;
    try {
        const response = await fetch(`/api/transit?bbox=${bbox}&maxAgeMinutes=${String(maxAgeMinutes)}`);
        if (!response.ok) {
            return err({ message: `GET /api/transit responded ${String(response.status)}` });
        }
        const json: unknown = await response.json();
        const parsed = TransitResponseSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/transit returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/transit', cause });
    }
}

function buildTransitPopup(vehicle: TransitVehicle, now: Date = new Date()): HTMLElement {
    const root = document.createElement('div');
    root.className = 'transit-popup';

    if (vehicle.line !== null) {
        const line = document.createElement('div');
        line.className = 'transit-popup-line';
        line.textContent = vehicle.line;
        root.append(line);
    }

    // Show whichever of origin/destination Entur's record actually carries
    // -- a vehicle with only one of the two previously showed neither, the
    // full "X → Y" line gated on both being present at once. One-sided
    // still tells a reader something ("from Sortland", "to Svolvær")
    // rather than nothing at all.
    if (vehicle.origin !== null && vehicle.destination !== null) {
        const route = document.createElement('div');
        route.className = 'transit-popup-route';
        route.textContent = t('map.transitRoute', { from: vehicle.origin, to: vehicle.destination });
        root.append(route);
    } else if (vehicle.origin !== null) {
        const route = document.createElement('div');
        route.className = 'transit-popup-route';
        route.textContent = t('map.transitRouteFrom', { from: vehicle.origin });
        root.append(route);
    } else if (vehicle.destination !== null) {
        const route = document.createElement('div');
        route.className = 'transit-popup-route';
        route.textContent = t('map.transitRouteTo', { to: vehicle.destination });
        root.append(route);
    }

    const punctuality = punctualityText(vehicle.delaySeconds);
    if (punctuality !== null) {
        const punctualityLine = document.createElement('div');
        punctualityLine.className = 'transit-popup-punctuality';
        punctualityLine.textContent = punctuality;
        root.append(punctualityLine);
    }

    const mode = document.createElement('div');
    mode.className = 'transit-popup-mode';
    mode.textContent = t(MODE_LABEL_KEYS[vehicle.mode]);
    root.append(mode);

    // Both `null` and `""` mean absent -- see `TransitVehicleSchema`'s own
    // doc comment on `operatorRef`.
    if (vehicle.operatorRef !== null && vehicle.operatorRef !== '') {
        const operator = document.createElement('div');
        operator.className = 'transit-popup-operator';
        operator.textContent = vehicle.operatorRef;
        root.append(operator);
    }

    const age = document.createElement('div');
    age.className = 'transit-popup-updated';
    age.textContent = t('map.popupUpdated', { age: formatAge(new Date(vehicle.recordedAt), now) });
    root.append(age);

    return root;
}

function buildTransitPinIcon(L: typeof Leaflet, vehicle: TransitVehicle): Leaflet.DivIcon {
    const plate = document.createElement('span');
    plate.className = 'transit-pin-plate';
    plate.style.setProperty(TRANSIT_COLOR_PROPERTY, colorFor(vehicle));

    const glyph = document.createElement('span');
    glyph.className = 'transit-pin-glyph';
    // A build-time constant (`glyphs/*.svg`), never anything that came off
    // the wire.
    glyph.innerHTML = MODE_GLYPHS[vehicle.mode];
    glyph.setAttribute('aria-hidden', 'true');
    plate.append(glyph);

    // The number is what a person reads across a room -- a ferry's
    // `publicCode` (e.g. "18-703") is meaningless on a wall, and its full
    // `line` name is too long for a pin, so a ferry pin carries the glyph
    // alone.
    if (vehicle.mode === 'bus' && vehicle.publicCode !== null) {
        const code = document.createElement('span');
        code.className = 'transit-pin-code';
        code.textContent = vehicle.publicCode;
        plate.append(code);
    }

    return L.divIcon({
        className: 'transit-pin',
        html: plate,
        iconSize: [TRANSIT_PIN_PX, TRANSIT_PIN_PX],
        iconAnchor: [TRANSIT_PIN_PX / 2, TRANSIT_PIN_PX / 2],
    });
}

/** What the pin's artwork is derived from -- a vehicle that changes none of these renders the identical icon, so a poll that only moved the clock on does not rebuild it. */
function iconKeyOf(vehicle: TransitVehicle): string {
    return `${vehicle.mode}:${vehicle.publicCode ?? ''}:${String(isLateEnoughToTint(vehicle.delaySeconds))}`;
}

interface TransitEntry {
    marker: Leaflet.Marker;
    vehicle: TransitVehicle;
    iconKey: string;
}

export function mountTransitLayer(L: typeof Leaflet, map: Leaflet.Map, callbacks: LiveLayerCallbacks): () => void {
    return mountWhileEnabled(
        () => settings.get().transit.enabled,
        () => {
            const layerGroup = L.layerGroup().addTo(map);
            const entries = new Map<string, TransitEntry>();

            /**
             * Reads the *current* vehicle for `id` out of `entries`, not
             * the one captured when the popup was bound -- a popup opened
             * now, on a marker created a few polls ago, must show what the
             * last poll said (same reasoning as `roads.ts`'s `popupFor`).
             */
            function popupFor(id: string, fallback: TransitVehicle): HTMLElement {
                return buildTransitPopup(entries.get(id)?.vehicle ?? fallback);
            }

            function addEntry(vehicle: TransitVehicle): void {
                const marker = L.marker([vehicle.point.lat, vehicle.point.lng], { icon: buildTransitPinIcon(L, vehicle) });
                marker.bindPopup(() => popupFor(vehicle.id, vehicle), { className: 'transit-popup-wrapper', autoPanPadding: [20, 20] });
                marker.addTo(layerGroup);
                entries.set(vehicle.id, { marker, vehicle, iconKey: iconKeyOf(vehicle) });
            }

            function updateEntry(entry: TransitEntry, vehicle: TransitVehicle): void {
                entry.vehicle = vehicle;
                entry.marker.setLatLng([vehicle.point.lat, vehicle.point.lng]);

                const iconKey = iconKeyOf(vehicle);
                if (iconKey !== entry.iconKey) {
                    entry.marker.setIcon(buildTransitPinIcon(L, vehicle));
                    entry.iconKey = iconKey;
                }

                // An open popup is refreshed in place; a closed one
                // rebuilds from `entries` the next time it opens (see
                // `popupFor`).
                if (entry.marker.isPopupOpen()) entry.marker.setPopupContent(buildTransitPopup(vehicle));
            }

            function removeEntry(id: string): void {
                const entry = entries.get(id);
                if (!entry) return;
                layerGroup.removeLayer(entry.marker);
                entries.delete(id);
            }

            function clear(): void {
                for (const id of [...entries.keys()]) removeEntry(id);
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
            }

            // `resourceWithDynamicInterval`, not a plain `resource()` call:
            // a `settings.transit.pollSeconds` change must take effect on
            // the next poll, not wait for the layer to remount -- see its
            // own doc comment (`liveLayerMount.ts`).
            const res = resourceWithDynamicInterval(
                () => fetchTransit(map),
                () => Math.max(settings.get().transit.pollSeconds, TRANSIT_LAYER.minPollSeconds) * 1000,
            );

            const disposeEffect = effect(() => {
                const state = res.current.get().state.get();
                if (state.status !== 'ready') return;
                if (!state.data.configured) {
                    clear();
                    return;
                }

                // Read inside the effect, so flipping either checkbox
                // re-filters what is already on screen instead of waiting
                // for the next poll -- the same reasoning `roads.ts`'s
                // `showPlanned` read gets.
                const showBuses = settings.get().transit.showBuses;
                const showFerries = settings.get().transit.showFerries;
                const visible = state.data.vehicles.filter(
                    (vehicle) => (vehicle.mode === 'bus' && showBuses) || (vehicle.mode === 'ferry' && showFerries),
                );

                const wanted = new Set(visible.map((vehicle) => vehicle.id));
                for (const id of [...entries.keys()]) {
                    if (!wanted.has(id)) removeEntry(id);
                }
                for (const vehicle of visible) {
                    const entry = entries.get(vehicle.id);
                    if (entry) updateEntry(entry, vehicle);
                    else addEntry(vehicle);
                }

                // Always `0` hidden-by-age: a stale fix never reaches this
                // module at all (see this file's header comment), so there
                // is nothing here for that count to measure.
                callbacks.reportCount(visible.length, 0);
                callbacks.reportItems(
                    visible.map((vehicle) => ({
                        id: vehicle.id,
                        label: vehicle.publicCode ?? vehicle.line ?? t(MODE_LABEL_KEYS[vehicle.mode]),
                        detail: vehicle.destination ?? t(MODE_LABEL_KEYS[vehicle.mode]),
                        lat: vehicle.point.lat,
                        lng: vehicle.point.lng,
                    })),
                );
                callbacks.reportAttribution(TRANSIT_LAYER.attribution);
            });

            const disposeMoveRefetch = refetchOnMapMove(map, () => {
                res.refresh();
            });

            return function dispose(): void {
                disposeEffect();
                disposeMoveRefetch();
                res.dispose();
                for (const id of [...entries.keys()]) removeEntry(id);
                map.removeLayer(layerGroup);
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
            };
        },
    );
}
