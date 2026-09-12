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
import type { DeviceSettings } from '../../shared/schemas/device-settings.js';
import { MapConfigResponseSchema } from '../../shared/schemas/map-config.js';
import { deviceSettings, setDeviceSettings } from '../device-settings.js';
import { settings as sharedSettings } from '../settings-resource.js';
import { effect, signal } from '../core/signal.js';
import { t } from '../i18n/index.js';
import { nightSchedule } from '../shell/night-schedule.js';
import { claimPageStatus } from '../shell/page-status.js';
import './map/map.css';
import { activeMapInstance } from './map/activeMap.js';
import { applyTiles, disposeTiles, preconnectOriginFor, resolveBasemap, type Basemap, type Theme } from './map/tiles.js';
import { addMapBasemapControl } from './map/basemapControl.js';
import { addMapLocateControl, type LocateState } from './map/locateControl.js';
import { requestPosition } from '../geolocation.js';
import { setLocalOverride } from '../settings/localOverrides.js';
import { LOCATED_ZOOM, applyHomeView, startHomeViewSync } from './map/homeView.js';
import { createCameraMarkerLayer } from './map/markers.js';
import { buildPopupContent } from './map/popup.js';
import { addMapResetControl } from './map/resetControl.js';

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

/** Mirrors `shell/theme.ts`'s `resolveBaseTheme` -- kept local rather than importing from there, since that module's `matchMedia` listener is owned by `startThemeApplication`'s own lifecycle (started once, for the app's lifetime), not something this page's mount/unmount should share or re-trigger. */
function resolveBaseTheme(theme: DeviceSettings['theme'], prefersLight: boolean): 'dark' | 'light' {
    if (theme === 'system') return prefersLight ? 'light' : 'dark';
    return theme;
}

export function render(container: HTMLElement): () => void {
    // The live layers below publish the counts/attribution the masthead and
    // footer read; this is what takes those slots back when the map page
    // goes away (see `claimPageStatus`).
    const status = claimPageStatus();
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
            // A failure *after* the map was built (the live-layer chunk not
            // loading, say) leaves a live Leaflet instance behind the
            // "map unavailable" message, still holding tiles, listeners and
            // `activeMapInstance`. Tear down whatever exists before
            // replacing what is on screen.
            cleanupInner?.();
            cleanupInner = undefined;
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

        /**
         * The basemap on screen right now, derived fresh from the signals
         * it depends on: the device's own choice first (`auto` unless
         * someone pressed the basemap button), then the theme the night
         * schedule and device settings resolve to. Called from inside
         * effects on both sides -- the tile effect below and the basemap
         * control's own -- so each tracks those signals itself.
         */
        function currentBasemap(): Basemap {
            const night = nightSchedule.get();
            const base = resolveBaseTheme(deviceSettings.get().theme, systemPrefersLight.get());
            const theme: Theme = night.mode === 'dark' && night.active ? 'dark' : base;
            return resolveBasemap(deviceSettings.get().basemap, theme);
        }

        const disposeThemeEffect = effect(() => {
            const basemap = currentBasemap();
            applyTiles(L, map, basemap, cartoApiKey);
            preconnectLink.href = preconnectOriginFor(basemap);
        });

        // — home view: applied once now, and again on idle-reset; never
        // reactively re-applied on an unrelated settings poll. —
        const disposeHomeViewSync = startHomeViewSync(map);

        // ...and on demand, for whoever just panned the display to Spain.
        const disposeResetControl = addMapResetControl(L, map, {
            label: t('map.resetView'),
            onReset: () => {
                // This device's effective home view -- the same one
                // `startHomeViewSync` applies on mount and idle-reset.
                // That is the shared, server-persisted one until somebody
                // presses locate below, after which "back to the home
                // view" means back to *their* position rather than to
                // Sortland. Reading the server value here instead would
                // make the locate button look broken five minutes later.
                applyHomeView(map, sharedSettings.get().homeView);
            },
        });

        // ...and under it, the basemap this display draws. Device-local
        // and persisted (`setDeviceSettings`), so the kiosk comes back up
        // on whatever was last chosen rather than reverting on every
        // reload -- same treatment as the theme and the font scale.
        const disposeBasemapControl = addMapBasemapControl(L, map, {
            current: currentBasemap,
            labelFor: (next) => t('map.basemapSwitchTo', { name: t(`map.basemap.${next}`) }),
            onSelect: (next) => {
                setDeviceSettings({ basemap: next });
            },
        });

        // ...and under that, the visitor's own position. Writes a
        // device-local override rather than a shared `PATCH`, even for a
        // logged-in device: "my position" is per-device by definition, and
        // writing it to `data/settings.json` would move the kiosk's home
        // view for everybody. This is the one deliberate exception to the
        // logged-in-writes-are-shared rule, which is why it calls
        // `setLocalOverride` directly rather than going through the store.
        const locateState = signal<LocateState>('idle');
        const disposeLocateControl = addMapLocateControl(L, map, {
            state: () => locateState.get(),
            labelFor: (state) => t(`map.locate.${state}`),
            messageFor: (state) => (state === 'idle' || state === 'locating' || state === 'located' ? null : t(`map.locate.${state}`)),
            onLocate: () => {
                locateState.set('locating');
                void requestPosition().then((outcome) => {
                    if (outcome.kind !== 'ok') {
                        locateState.set(outcome.kind === 'denied' ? 'denied' : 'unavailable');
                        return;
                    }
                    const homeView = { lat: outcome.lat, lng: outcome.lng, zoom: LOCATED_ZOOM };
                    setLocalOverride('homeView', homeView);
                    applyHomeView(map, homeView);
                    locateState.set('located');
                });
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
        // glyphs, polled per the current viewport. See `map/layers.ts`.
        //
        // Imported here rather than at the top of the file for the same
        // reason Leaflet itself is: none of it can do anything without a
        // Leaflet map, so none of it belongs in the bundle every page
        // pays for. It is a big subtree -- both live layers, the glyph and
        // trail renderers, clustering, dead reckoning -- and it was the
        // single largest thing in the initial chunk that only one page
        // could ever use. —
        /**
         * Everything built above, torn down in the order it was built --
         * with the live layers passed in once they exist.
         *
         * Registered as `cleanupInner` *before* the deferred import below,
         * not after: an `await` with the map, its tiles, its marker layer
         * and `activeMapInstance` already alive is a window in which
         * `dispose()` can run, and a `dispose()` that found no
         * `cleanupInner` would leave every one of them behind.
         */
        function cleanupWith(disposeLiveLayers?: () => void): void {
            activeMapInstance.set(null);
            disposeLiveLayers?.();
            markerLayer.dispose();
            disposeLocateControl();
            disposeBasemapControl();
            disposeResetControl();
            disposeHomeViewSync();
            disposeThemeEffect();
            mql.removeEventListener('change', onMqlChange);
            disposeTiles(map);
            map.remove();
        }
        cleanupInner = (): void => {
            cleanupWith();
        };

        // — live layers (ships, aircraft) —
        const { mountLiveLayers } = await import('./map/layers.js');
        if (isDisposed()) return; // navigated away while the layer code loaded; `dispose()` has already run the cleanup above
        const disposeLiveLayers = mountLiveLayers(L, map, status);

        // The "N cameras without placement" link is gone with the
        // 2026-09-07 design: it nagged permanently about a job that is
        // done once, in settings, and it sat over the map for the rest of
        // the display's life.

        cleanupInner = (): void => {
            cleanupWith(disposeLiveLayers);
        };
    }

    return function dispose(): void {
        disposed = true;
        mapConfigAbortController.abort();
        cleanupInner?.();
        status.release();
        preconnectLink.remove();
        wrapper.remove();
    };
}
