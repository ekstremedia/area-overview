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
import { MapConfigResponseSchema } from '../../shared/schemas/map-config.js';
import { deviceSettings } from '../device-settings.js';
import { settings as sharedSettings } from '../settings-resource.js';
import { effect, signal } from '../core/signal.js';
import { t } from '../i18n/index.js';
import { nightSchedule } from '../shell/night-schedule.js';
import './map/map.css';
import { activeMapInstance } from './map/activeMap.js';
import { applyTiles, disposeTiles, preconnectOriginFor, type Theme } from './map/tiles.js';
import { applyHomeView, startHomeViewSync } from './map/homeView.js';
import { createCameraMarkerLayer } from './map/markers.js';
import { mountLiveLayers } from './map/layers.js';
import { buildPopupContent } from './map/popup.js';
import { addMapResetControl } from './map/resetControl.js';
import { createPointForecastController, mountPointForecastPanel } from './map/pointForecast.js';

/**
 * Timeout (ms) for fetching the CARTO basemap key. This is a local
 * BFF call, so a few seconds is plenty; we pick a middle ground between
 * the 2s healthz probe and the 4s tile safety timeout.
 */
const MAP_CONFIG_FETCH_TIMEOUT_MS = 3000;

/**
 * Fetches the CARTO basemap key from `GET /api/map-config` (see
 * `src/server/routes/map-config.ts`). Never throws: a network error, a
 * non-2xx response, timeout, abortion, or a payload that fails schema
 * validation all fall back to `''`, same as an unconfigured key on the
 * server -- the `dark` theme's tiles still load, just watermarked by
 * CARTO, matching how the BarentsWatch/OpenSky live layers degrade on
 * missing credentials rather than blocking the page.
 *
 * The provided `signal` will abort the fetch if this page is disposed
 * (navigation away) or the timeout elapses, whichever comes first.
 */
async function fetchCartoApiKey(signal: AbortSignal): Promise<string> {
    try {
        const response = await fetch('/api/map-config', { signal });
        if (!response.ok) return '';
        const json: unknown = await response.json();
        const parsed = MapConfigResponseSchema.safeParse(json);
        return parsed.success ? parsed.data.cartoApiKey : '';
    } catch {
        return '';
    }
}

/**
 * `true` when `target` is (or is inside) an open Leaflet popup -- Leaflet's
 * own `L.DomEvent.disableClickPropagation` shield on
 * `.leaflet-popup-content-wrapper` is supposed to make this unnecessary,
 * but a real pointer/mouse event sequence landing on popup content (e.g.
 * `ships.ts`'s cluster list rows) proved that shield doesn't reliably stop
 * the map's own 'click' from also firing for that same click -- see the
 * `onMapClick` doc comment in `render()` below for the full story. Exported
 * so the regression this guards against can be unit-tested directly: a
 * bare synthetic `.click()` in happy-dom does *not* reproduce the leak
 * (Leaflet's own shield does stop it there), so asserting on this function
 * is the effective way to catch it, not a simulated DOM event sequence.
 */
export function isInsideLeafletPopup(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.leaflet-popup') !== null;
}

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

    // AbortController for the map-config fetch. Combined with a timeout
    // signal, this ensures the fetch completes (or aborts) before the page
    // renders, and disposes cleanly if navigation away happens first.
    const mapConfigAbortController = new AbortController();

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

        // Combine the timeout signal with the manual abort controller so the
        // fetch aborts on timeout (after MAP_CONFIG_FETCH_TIMEOUT_MS) *or*
        // when dispose() aborts the controller (navigation away), whichever
        // comes first. Both scenarios fall through to the `catch` and return ''.
        const timeoutSignal = AbortSignal.timeout(MAP_CONFIG_FETCH_TIMEOUT_MS);
        const combinedSignal = AbortSignal.any([timeoutSignal, mapConfigAbortController.signal]);

        const cartoApiKey = await fetchCartoApiKey(combinedSignal);
        if (isDisposed()) return; // navigated away while fetching the map config

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
            applyTiles(L, map, theme, cartoApiKey);
            preconnectLink.href = preconnectOriginFor(theme);
        });

        // — home view: applied once now, and again on idle-reset; never
        // reactively re-applied on an unrelated settings poll. —
        const disposeHomeViewSync = startHomeViewSync(map);

        // ...and on demand, for whoever just panned the display to Spain.
        const disposeResetControl = addMapResetControl(L, map, {
            label: t('map.resetView'),
            onReset: () => {
                // The shared, server-persisted home view -- the same one
                // `startHomeViewSync` applies on mount and idle-reset, not
                // a device-local copy.
                applyHomeView(map, sharedSettings.get().homeView);
            },
        });

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

        // The "N cameras without placement" link is gone with the
        // 2026-09-07 design: it nagged permanently about a job that is
        // done once, in settings, and it sat over the map for the rest of
        // the display's life.

        // — tap-empty-map point forecast. Leaflet doesn't fire the map's own
        // 'click' for a marker click that *opens* a popup (`Marker`'s
        // `_openPopup` calls `DomEvent.stop` on the originating event), but
        // that only covers the click that opens a popup -- a click on
        // content *inside* an already-open popup (e.g. `ships.ts`'s cluster
        // list rows, or its "back to list" button) is a separate click
        // event on a separate DOM subtree (`.leaflet-popup-content`), never
        // touched by `_openPopup`'s stop call. Leaflet's `Popup` class is
        // supposed to shield its own content from map clicks
        // (`L.DomEvent.disableClickPropagation` on
        // `.leaflet-popup-content-wrapper`), but real pointer/mouse event
        // sequences (not a bare synthetic `.click()`) proved that shield
        // doesn't reliably stop this handler from firing for a click that
        // lands on popup content, closing the popup and updating the
        // forecast panel as an unwanted side effect. Guard explicitly by
        // ignoring any click whose target is inside `.leaflet-popup`. —
        const forecastController = createPointForecastController();
        const disposeForecastPanel = mountPointForecastPanel(wrapper, forecastController.state, (lat, lng) => {
            forecastController.requestForecast(lat, lng);
        });
        const onMapClick = (event: Leaflet.LeafletMouseEvent): void => {
            if (isInsideLeafletPopup(event.originalEvent.target)) return;
            forecastController.requestForecast(event.latlng.lat, event.latlng.lng);
        };
        map.on('click', onMapClick);

        cleanupInner = (): void => {
            activeMapInstance.set(null);
            map.off('click', onMapClick);
            disposeForecastPanel();
            forecastController.dispose();
            disposeLiveLayers();
            markerLayer.dispose();
            disposeResetControl();
            disposeHomeViewSync();
            disposeThemeEffect();
            mql.removeEventListener('change', onMqlChange);
            disposeTiles(map);
            map.remove();
        };
    }

    return function dispose(): void {
        disposed = true;
        mapConfigAbortController.abort();
        cleanupInner?.();
        preconnectLink.remove();
        wrapper.remove();
    };
}
