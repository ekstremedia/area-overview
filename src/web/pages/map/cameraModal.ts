/**
 * The road-camera modal: what a road-camera pin (or a cluster of them)
 * opens. One still image large enough to read from across a room, the
 * site it belongs to, the road-weather line under it, and -- for a
 * cluster -- a grid of that site's other views.
 *
 * **A real overlay, not a Leaflet popup.** A popup is positioned by its
 * marker: on a 1024x600 screen a 800x600 photograph anchored to a pin
 * near an edge either overflows the map or gets shoved around by
 * `autoPan` until the picture is somewhere other than where the eye
 * went. This is a picture, not an annotation, so it takes the screen.
 *
 * Three things about Vegvesen's imagery shape this file:
 *
 *  - **There are no thumbnail URLs.** Every image in the grid is the
 *    full 800x600 JPEG, so a six-view site is six full photographs. That
 *    is why the grid genuinely defers each `src` until its tile is on
 *    screen (`IntersectionObserver`, see `observeLazily`) rather than
 *    relying on `loading="lazy"`, which a browser is free to ignore.
 *  - **There is no capture time.** Upstream publishes roughly once a
 *    minute and serves no `Last-Modified`, so there is no age to show --
 *    the answer is to refresh, on `ROAD_CAMERA_REFRESH_MS`. Only the
 *    image actually being looked at refreshes; a grid of twelve
 *    re-fetching every minute would be ~3 MB/min for pictures nobody is
 *    reading.
 *  - **The bytes are hotlinked by the visitor's browser**, never proxied
 *    by the BFF. There is no `Cache-Control` on them either, so the
 *    refresh carries a `t=` bucket (see `bucketedUrl`) -- without it the
 *    browser's heuristic cache can answer a re-set `src` with the same
 *    picture forever.
 *
 * The idle reset closes the modal (`IDLE_RESET_EVENT`), which is the
 * whole reason this listens for it: without that, a visitor who walks
 * away leaves the wall display sitting on a webcam all night, and the
 * idle reset's usual "navigate home" does nothing to an overlay that is
 * not a route.
 */
import type { RoadCamera, RoadCameraSiteWeather } from '../../../shared/schemas/road-cameras.js';
import { formatNumber, t } from '../../i18n/index.js';
import { IDLE_RESET_EVENT } from '../../shell/idle.js';
import { formatRoadNumber } from './roadNumber.js';

/**
 * Vegvesen's own stated publication frequency
 * (`cctvStillImageUpdateFrequency = 60`). Also the bucket width: every
 * refresh inside the same minute resolves to the same URL, so a re-set
 * `src` that happens to fire twice in one bucket costs nothing.
 */
export const ROAD_CAMERA_REFRESH_MS = 60_000;

/**
 * How many views a grid shows before the "vis alle" affordance. Twelve
 * full-size JPEGs is already the most a 1024x600 screen can show as
 * anything but postage stamps, and every one of them is a real 800x600
 * download.
 */
export const ROAD_CAMERA_GRID_LIMIT = 12;

/** The query parameter the refresh bucket rides in -- see this file's doc comment on why a bare `src` re-set is not enough. */
const CACHE_BUCKET_PARAM = 't';

/**
 * The image URL for a given instant, bucketed to the minute.
 *
 * Exported for the tests, which assert that two instants inside one
 * bucket produce the identical URL and two instants either side of one
 * do not.
 */
export function bucketedUrl(imageUrl: string, atMs: number): string {
    const url = new URL(imageUrl);
    url.searchParams.set(CACHE_BUCKET_PARAM, String(Math.floor(atMs / ROAD_CAMERA_REFRESH_MS)));
    return url.toString();
}

/** "Hadselbrua · mot Stokmarknes" -- the direction is often null, and then the site name stands alone. */
function cameraTitle(camera: RoadCamera): string {
    return camera.direction === null || camera.direction === '' ? camera.name : `${camera.name} · ${camera.direction}`;
}

/**
 * The road-weather line: **only** the readings that are non-null.
 *
 * Nulls are the norm here, not an error -- wind is missing on roughly
 * 200 of 464 stations -- so a missing reading is silently absent rather
 * than shown as a dash. Anything on screen is a real measurement.
 */
export function weatherChips(weather: RoadCameraSiteWeather): string[] {
    const chips: string[] = [];
    if (weather.airTemperature !== null) chips.push(t('map.roadCameraAir', { value: formatNumber(weather.airTemperature, t('unit.celsius')) }));
    if (weather.roadTemperature !== null) chips.push(t('map.roadCameraRoad', { value: formatNumber(weather.roadTemperature, t('unit.celsius')) }));
    if (weather.windSpeed !== null) {
        const mean = formatNumber(weather.windSpeed, t('unit.metersPerSecond'));
        chips.push(
            weather.windGust === null
                ? t('map.roadCameraWind', { value: mean })
                : t('map.roadCameraWindGust', { value: mean, gust: formatNumber(weather.windGust, t('unit.metersPerSecond')) }),
        );
    } else if (weather.windGust !== null) {
        // A gust with no mean beside it happens; it is still the reading
        // somebody standing on that bridge would want.
        chips.push(t('map.roadCameraGust', { value: formatNumber(weather.windGust, t('unit.metersPerSecond')) }));
    }
    if (weather.precipitationIntensity !== null) {
        chips.push(t('map.roadCameraPrecipitation', { value: formatNumber(weather.precipitationIntensity, t('unit.millimetersPerHour')) }));
    }
    return chips;
}

/** Leaves full screen where the environment has it at all -- see the call site in `renderDetail` for why this is feature-detected. */
function exitFullscreen(): void {
    if (typeof document.exitFullscreen !== 'function') return;
    document.exitFullscreen().catch(() => undefined);
}

export interface RoadCameraModalOptions {
    /** The cameras this pin stands for: one for a lone pin, a site's (or a cluster's) several for a badge. */
    cameras: readonly RoadCamera[];
    /** `RoadCamerasResponse.weatherBySite`, joined per camera on `siteId`. Most sites are simply absent from it. */
    weatherBySite: Readonly<Record<string, RoadCameraSiteWeather>>;
    /** Defaults to `document.body`: the modal takes the screen, not the map container. */
    host?: HTMLElement;
    /** Defaults to `Date.now` -- injected by the tests so the refresh bucket is deterministic. */
    now?: () => number;
}

export interface RoadCameraModalHandle {
    el: HTMLElement;
    close: () => void;
}

/**
 * The one modal that can be open at a time. A second pin tapped while
 * one is open replaces it rather than stacking a second overlay nobody
 * can see behind the first.
 */
let openModal: RoadCameraModalHandle | undefined;

/**
 * Defers an image's `src` until its element is actually on screen.
 *
 * `loading="lazy"` is set as well, but it is advice a browser may
 * decline (and jsdom ignores entirely); this is the part that is real.
 * Where `IntersectionObserver` does not exist at all the images load
 * immediately -- a degraded but working grid beats an empty one.
 */
function observeLazily(images: readonly HTMLImageElement[], srcFor: (image: HTMLImageElement) => string): () => void {
    if (typeof IntersectionObserver !== 'function') {
        for (const image of images) image.src = srcFor(image);
        return () => undefined;
    }
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const image = entry.target as HTMLImageElement;
            // Once only: a tile scrolled out and back must not re-download
            // a 500 KB photograph, and these deliberately never refresh.
            observer.unobserve(image);
            if (image.getAttribute('src') === null) image.src = srcFor(image);
        }
    });
    for (const image of images) observer.observe(image);
    return () => {
        observer.disconnect();
    };
}

/**
 * Opens the modal for `cameras`. Returns a handle whose `close()` is
 * idempotent -- it is called by the close button, the veil, Escape, the
 * idle reset, and by whoever opens the next modal.
 */
export function openRoadCameraModal(options: RoadCameraModalOptions): RoadCameraModalHandle {
    openModal?.close();

    const host = options.host ?? document.body;
    const now = options.now ?? (() => Date.now());
    const cameras = [...options.cameras];

    const root = document.createElement('div');
    root.className = 'road-camera-modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    const veil = document.createElement('div');
    veil.className = 'road-camera-modal-veil';

    const panel = document.createElement('div');
    panel.className = 'road-camera-modal-panel';

    const head = document.createElement('div');
    head.className = 'road-camera-modal-head';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'road-camera-modal-back';
    back.textContent = t('map.roadCameraBack');
    back.hidden = true;

    const headings = document.createElement('div');
    headings.className = 'road-camera-modal-headings';
    const title = document.createElement('div');
    title.className = 'road-camera-modal-title';
    const where = document.createElement('div');
    where.className = 'road-camera-modal-where';
    headings.append(title, where);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'road-camera-modal-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', t('map.roadCameraClose'));

    head.append(back, headings, close);

    const body = document.createElement('div');
    body.className = 'road-camera-modal-body';

    const weatherRow = document.createElement('div');
    weatherRow.className = 'road-camera-modal-weather';

    panel.append(head, body, weatherRow);
    root.append(veil, panel);
    host.append(root);

    /** The image currently being looked at, and so the only one the refresh timer touches. */
    let visibleImage: HTMLImageElement | undefined;
    let visibleCamera: RoadCamera | undefined;
    let disposeLazy: (() => void) | undefined;
    let closed = false;

    function renderWeather(camera: RoadCamera | undefined): void {
        weatherRow.replaceChildren();
        if (!camera) return;
        const weather = options.weatherBySite[camera.siteId];
        if (!weather) return;
        for (const text of weatherChips(weather)) {
            const chip = document.createElement('span');
            chip.className = 'road-camera-modal-weather-item';
            chip.textContent = text;
            weatherRow.append(chip);
        }
    }

    /** One camera, large. Tapping the picture takes it full screen in place (Fullscreen API), which is as close as a browser gets to "just the picture". */
    function renderDetail(camera: RoadCamera, fromGrid: boolean): void {
        disposeLazy?.();
        disposeLazy = undefined;
        body.replaceChildren();
        back.hidden = !fromGrid;
        title.textContent = camera.name;
        where.textContent = [formatRoadNumber(camera.roadNumber), camera.direction].filter((part) => part !== null && part !== '').join(' · ');

        const stage = document.createElement('button');
        stage.type = 'button';
        stage.className = 'road-camera-modal-stage';
        stage.setAttribute('aria-label', t('map.roadCameraFullscreen'));

        const image = document.createElement('img');
        image.className = 'road-camera-modal-image';
        image.alt = t('map.roadCameraImageAlt', { name: cameraTitle(camera) });
        image.src = bucketedUrl(camera.imageUrl, now());
        stage.append(image);

        stage.addEventListener('click', () => {
            // Feature-detected rather than assumed: the DOM typings say
            // both of these always exist, but a test DOM has neither, and
            // a real browser can still *reject* the request (it only
            // grants full screen from a gesture it recognises). A refused
            // full screen leaves the modal exactly as it was, which is a
            // perfectly good outcome -- hence the swallowed rejection.
            if (document.fullscreenElement) {
                exitFullscreen();
                return;
            }
            if (typeof stage.requestFullscreen !== 'function') return;
            stage.requestFullscreen().catch(() => undefined);
        });

        body.append(stage);
        visibleImage = image;
        visibleCamera = camera;
        renderWeather(camera);
    }

    /**
     * A site's views as a grid. Capped at `ROAD_CAMERA_GRID_LIMIT`, with
     * "vis alle" for the rest -- a cluster can hold considerably more
     * than one site's four orientations when two sites sit within a tap
     * of each other on a zoomed-out map.
     */
    function renderGrid(): void {
        disposeLazy?.();
        body.replaceChildren();
        back.hidden = true;
        visibleImage = undefined;
        visibleCamera = undefined;
        title.textContent = t('map.roadCameraCluster', { count: cameras.length });
        where.textContent = '';
        renderWeather(undefined);

        const grid = document.createElement('div');
        grid.className = 'road-camera-modal-grid';
        body.append(grid);

        const lazyImages: HTMLImageElement[] = [];
        const srcById = new Map<string, string>();

        function appendTiles(from: number, to: number): void {
            for (const camera of cameras.slice(from, to)) {
                const tile = document.createElement('button');
                tile.type = 'button';
                tile.className = 'road-camera-thumb';

                const image = document.createElement('img');
                image.className = 'road-camera-thumb-image';
                image.alt = t('map.roadCameraImageAlt', { name: cameraTitle(camera) });
                // No `src` yet: that is the point (see `observeLazily`).
                image.loading = 'lazy';
                image.dataset.cameraId = camera.id;
                srcById.set(camera.id, bucketedUrl(camera.imageUrl, now()));

                const label = document.createElement('span');
                label.className = 'road-camera-thumb-label';
                label.textContent = cameraTitle(camera);

                tile.append(image, label);
                tile.addEventListener('click', () => {
                    renderDetail(camera, true);
                });
                grid.append(tile);
                lazyImages.push(image);
            }
        }

        appendTiles(0, ROAD_CAMERA_GRID_LIMIT);

        if (cameras.length > ROAD_CAMERA_GRID_LIMIT) {
            const showAll = document.createElement('button');
            showAll.type = 'button';
            showAll.className = 'road-camera-modal-show-all';
            showAll.textContent = t('map.roadCameraShowAll', { count: cameras.length - ROAD_CAMERA_GRID_LIMIT });
            showAll.addEventListener('click', () => {
                showAll.remove();
                const from = grid.childElementCount;
                appendTiles(from, cameras.length);
                disposeLazy?.();
                disposeLazy = observeLazily(lazyImages, (image) => srcById.get(image.dataset.cameraId ?? '') ?? '');
            });
            body.append(showAll);
        }

        disposeLazy = observeLazily(lazyImages, (image) => srcById.get(image.dataset.cameraId ?? '') ?? '');
    }

    back.addEventListener('click', () => {
        renderGrid();
    });

    /**
     * Re-sets the visible image's `src` on the minute bucket. A grid tile
     * is never touched: it has no `src` of its own to refresh until it
     * scrolls in, and a dozen full-size JPEGs re-downloading every minute
     * is exactly the traffic this app promised not to generate against a
     * service with no SLA.
     */
    const refreshTimer = setInterval(() => {
        if (!visibleImage || !visibleCamera) return;
        visibleImage.src = bucketedUrl(visibleCamera.imageUrl, now());
    }, ROAD_CAMERA_REFRESH_MS);

    const handle: RoadCameraModalHandle = {
        el: root,
        close(): void {
            if (closed) return;
            closed = true;
            clearInterval(refreshTimer);
            disposeLazy?.();
            document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener(IDLE_RESET_EVENT, onIdleReset);
            // Leaving the picture full screen behind would strand the
            // display on an image with nothing left to close it.
            if (document.fullscreenElement && root.contains(document.fullscreenElement)) exitFullscreen();
            root.remove();
            if (openModal === handle) openModal = undefined;
        },
    };

    function onKeyDown(event: KeyboardEvent): void {
        if (event.key === 'Escape') handle.close();
    }

    function onIdleReset(): void {
        handle.close();
    }

    close.addEventListener('click', () => {
        handle.close();
    });
    veil.addEventListener('click', () => {
        handle.close();
    });
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener(IDLE_RESET_EVENT, onIdleReset);

    const [only] = cameras;
    if (cameras.length === 1 && only) renderDetail(only, false);
    else renderGrid();

    openModal = handle;
    return handle;
}

/** Closes whatever is open, if anything -- the layer's own teardown path, so a disabled layer does not leave its modal on screen. */
export function closeRoadCameraModal(): void {
    openModal?.close();
}
