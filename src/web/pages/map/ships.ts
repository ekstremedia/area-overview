/**
 * The ships (BarentsWatch AIS) live layer: polls `GET /api/ships?bbox=`
 * for the map's current viewport, renders each ship as a cyan
 * heading-rotated triangle via `canvasGlyphLayer.ts`, and reports its
 * on-screen count/attribution through `callbacks` for the masthead/
 * footer. Mounted only through `layers.ts`'s `mountLiveLayers` --
 * `MapPage.ts` never imports this file directly.
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
import type { GlyphDescriptor } from './glyphs.js';
import { SHIP_GLYPH_COLOR } from './liveLayerColors.js';
import { mapToBboxQuery, mountWhileEnabled, type LiveLayerCallbacks } from './liveLayerMount.js';

const SHIP_WIDTH_PX = 14;
const SHIP_HEIGHT_PX = 19;
const HIT_RADIUS_PX = 22; // half of a 44px tap diameter

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
            });

            const pollSeconds = Math.max(settings.get().ships.pollSeconds, SHIPS_LAYER.minPollSeconds);
            const res = resource(() => fetchShips(map), { intervalMs: pollSeconds * 1000 });

            function clear(): void {
                canvasLayer.update([], settings.get().ships.maxAgeMinutes, new Date());
                callbacks.reportCount(0);
                callbacks.reportAttribution(undefined);
            }

            const disposeEffect = effect(() => {
                const state = res.state.get();
                if (state.status !== 'ready') return;
                if (!state.data.configured) {
                    clear();
                    return;
                }
                canvasLayer.update(state.data.ships.map(toGlyph), settings.get().ships.maxAgeMinutes, new Date());
                callbacks.reportCount(canvasLayer.count());
                callbacks.reportAttribution(SHIPS_LAYER.attribution);
            });

            return function dispose(): void {
                disposeEffect();
                res.dispose();
                canvasLayer.dispose();
                callbacks.reportCount(0);
                callbacks.reportAttribution(undefined);
            };
        },
    );
}
