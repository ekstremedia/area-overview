/**
 * The map page (artboard 01): the app's headline feature. `leaflet` (and
 * its CSS) is imported dynamically, *inside* `render()`, so the library
 * never ships in the app's initial bundle -- verify after `npm run
 * build` that `dist/web/assets/` shows Leaflet as its own separate,
 * lazily-loaded chunk, not folded into the small entry chunk every other
 * page shares.
 *
 * Ships/aircraft (Phase 7) mount through `map/layers.ts`'s
 * `mountLiveLayers` -- this file never imports `map/ships.ts`/
 * `map/aircraft.ts` directly, so a future third live layer is added
 * entirely within `layers.ts` with no change here. Cameras deliberately
 * bypass that registry (`map/markers.ts` is hand-wired directly, per
 * Terje's explicit choice).
 */
import type * as Leaflet from 'leaflet';
import type { DeviceSettings } from '../../shared/schemas/device-settings.js';
import { deviceSettings } from '../device-settings.js';
import { effect, signal } from '../core/signal.js';
import { t } from '../i18n/index.js';
import { nightSchedule } from '../shell/night-schedule.js';
import './map/map.css';
import { activeMapInstance } from './map/activeMap.js';
import { applyTiles, disposeTiles, preconnectOriginFor, type Theme } from './map/tiles.js';
import { startHomeViewSync } from './map/homeView.js';
import { createCameraMarkerLayer, markerData } from './map/markers.js';
import { mountLiveLayers } from './map/layers.js';
import { buildPopupContent } from './map/popup.js';
import { createPointForecastController, mountPointForecastPanel } from './map/pointForecast.js';

/** Mirrors `shell/theme.ts`'s `resolveBaseTheme` -- kept local rather than importing from there, since that module's `matchMedia` listener is owned by `startThemeApplication`'s own lifecycle (started once, for the app's lifetime), not something this page's mount/unmount should share or re-trigger. */
function resolveBaseTheme(theme: DeviceSettings['theme'], prefersLight: boolean): 'dark' | 'light' {
    if (theme === 'system') return prefersLight ? 'light' : 'dark';
    return theme;
}

export function render(container: HTMLElement): () => void {
    let disposed = false;
    // Read through a function, not the bare `disposed` variable, below: it
    // can flip to `true` from `dispose()` while suspended on the `await
    // Promise.all(...)`, and TS's control-flow narrowing can't see that
    // closure-based mutation -- reading it directly makes the compiler
    // (wrongly) treat the check as dead code (same issue documented in
    // `core/resource.ts`'s `isDisposed()`).
    function isDisposed(): boolean {
        return disposed;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'map-page';
    const mapDiv = document.createElement('div');
    mapDiv.className = 'map-canvas';
    wrapper.append(mapDiv);
    container.append(wrapper);

    const preconnectLink = document.createElement('link');
    preconnectLink.rel = 'preconnect';
    document.head.append(preconnectLink);

    let cleanupInner: (() => void) | undefined;

    /**
     * Rendered in `mapDiv` when the dynamic Leaflet import (or the map setup
     * that follows it) fails -- a real possibility on a kiosk over
     * unreliable Wi-Fi, or a corrupted CDN/cache chunk. Without this, a
     * rejected `Promise.all([import('leaflet'), ...])` would be an unhandled
     * rejection and the route would silently stay blank with no indication
     * why.
     */
    function renderMapUnavailable(): void {
        mapDiv.replaceChildren();
        const message = document.createElement('div');
        message.className = 'map-unavailable';
        const text = document.createElement('p');
        text.textContent = t('map.unavailable');
        const reloadButton = document.createElement('button');
        reloadButton.type = 'button';
        reloadButton.textContent = t('map.reload');
        reloadButton.addEventListener('click', () => {
            location.reload();
        });
        message.append(text, reloadButton);
        mapDiv.append(message);
    }

    void (async () => {
        try {
            await renderMap();
        } catch (error) {
            if (isDisposed()) return; // navigated away; nothing to render
            console.error('Failed to load the map page', error);
            renderMapUnavailable();
        }
    })();

    async function renderMap(): Promise<void> {
        const [L] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
        if (isDisposed()) return; // navigated away before Leaflet finished loading

        const map = L.map(mapDiv);
        activeMapInstance.set(map);

        // — theme-driven tiles, reactive: a device-theme or night-schedule
        // change while this page is open swaps tiles live (via `applyTiles`'s
        // own anti-flash logic), same as any other themed chrome. —
        const mql = matchMedia('(prefers-color-scheme: light)');
        const systemPrefersLight = signal(mql.matches);
        const onMqlChange = (event: MediaQueryListEvent): void => {
            systemPrefersLight.set(event.matches);
        };
        mql.addEventListener('change', onMqlChange);

        const disposeThemeEffect = effect(() => {
            const night = nightSchedule.get();
            const base = resolveBaseTheme(deviceSettings.get().theme, systemPrefersLight.get());
            const theme: Theme = night.mode === 'dark' && night.active ? 'dark' : base;
            applyTiles(L, map, theme);
            preconnectLink.href = preconnectOriginFor(theme);
        });

        // — home view: applied once now, and again on idle-reset; never
        // reactively re-applied on an unrelated settings poll. —
        const disposeHomeViewSync = startHomeViewSync(map);

        // — camera markers, updated in place across polls. —
        const markerLayer = createCameraMarkerLayer(L, map, (camera) =>
            buildPopupContent(camera, {
                onClose: () => {
                    map.closePopup();
                },
            }),
        );

        // — live layers (ships, aircraft): canvas-rendered, heading-rotated
        // glyphs, polled per the current viewport. See `map/layers.ts`. —
        const disposeLiveLayers = mountLiveLayers(L, map);

        // — "N cameras without placement" link, bottom-left. —
        const unplacedLink = document.createElement('a');
        unplacedLink.className = 'map-unplaced-link';
        unplacedLink.href = '#/settings';
        wrapper.append(unplacedLink);
        const disposeUnplacedEffect = effect(() => {
            const { unplaced } = markerData.get();
            if (unplaced.length === 0) {
                unplacedLink.style.display = 'none';
                return;
            }
            unplacedLink.style.display = '';
            unplacedLink.textContent = t('map.unplacedLink', { count: unplaced.length });
        });

        // — tap-empty-map point forecast. Leaflet doesn't fire the map's own
        // 'click' for a marker click that opens a popup (`Marker`'s
        // `_openPopup` calls `DomEvent.stop` on the originating event), so no
        // extra "did this hit a marker" check is needed here. —
        const forecastController = createPointForecastController();
        const disposeForecastPanel = mountPointForecastPanel(wrapper, forecastController.state, (lat, lng) => {
            forecastController.requestForecast(lat, lng);
        });
        const onMapClick = (event: Leaflet.LeafletMouseEvent): void => {
            forecastController.requestForecast(event.latlng.lat, event.latlng.lng);
        };
        map.on('click', onMapClick);

        cleanupInner = (): void => {
            activeMapInstance.set(null);
            map.off('click', onMapClick);
            disposeForecastPanel();
            forecastController.dispose();
            disposeUnplacedEffect();
            unplacedLink.remove();
            disposeLiveLayers();
            markerLayer.dispose();
            disposeHomeViewSync();
            disposeThemeEffect();
            mql.removeEventListener('change', onMqlChange);
            disposeTiles(map);
            map.remove();
        };
    }

    return function dispose(): void {
        disposed = true;
        cleanupInner?.();
        preconnectLink.remove();
        wrapper.remove();
    };
}
