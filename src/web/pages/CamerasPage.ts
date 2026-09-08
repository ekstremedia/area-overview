/**
 * The camera grid (artboard 05): every camera the BFF knows about, two per
 * row, each a 16:9 image with an age badge, name, upstream location text
 * and a "Full screen -> #/cameras/<id>" link. Reuses the shared
 * `camerasResource` singleton (also read by the map page -- see
 * `camera-resource.ts`'s doc comment), so this page never opens its own
 * duplicate poll.
 *
 * This page has nothing to do with map *placement* (that's `markers.ts`'s
 * concern); "muted" here is purely about a stale/missing image, styled per
 * artboard 05's Spjutvika card.
 */
import type { Camera } from '../../shared/schemas/camera.js';
import { imageWithAge } from '../components/ImageWithAge.js';
import { errorBand } from '../components/ErrorBand.js';
import { CAMERAS_POLL_INTERVAL_MS, camerasResource } from '../camera-resource.js';
import { effect } from '../core/signal.js';
import { t } from '../i18n/index.js';
import { claimPageStatus } from '../shell/page-status.js';
import { createFreshnessReporter } from '../shell/resourceStatus.js';
import { enabledCameras } from './cameras/enabledCameras.js';
import { settings } from '../settings-resource.js';
import './cameras/cameras.css';

/** A camera image older than this (or missing entirely) renders the whole card in muted greys, per artboard 05's Spjutvika example -- a genuinely stale/absent snapshot, not a map-placement concern. */
const MUTED_CARD_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/** The age badge itself turns yellow past this -- much shorter than the muted-card threshold, since a 1-hour-old camera image is already worth flagging even though the card as a whole isn't yet "clearly stale". */
const BADGE_STALE_THRESHOLD_MS = 60 * 60 * 1000;

function isCardMuted(camera: Camera, now: Date): boolean {
    if (!camera.current_image_url || !camera.current_image_updated_at) return true;
    const ageMs = now.getTime() - new Date(camera.current_image_updated_at).getTime();
    return ageMs > MUTED_CARD_THRESHOLD_MS;
}

function buildCameraCard(camera: Camera, now: Date): HTMLElement {
    const card = document.createElement('div');
    card.className = 'camera-card';
    const muted = isCardMuted(camera, now);
    card.classList.toggle('camera-card--muted', muted);

    const image = imageWithAge({
        src: camera.current_image_url,
        alt: t('map.cameraImageAlt', { name: camera.name }),
        updatedAt: camera.current_image_updated_at ? new Date(camera.current_image_updated_at) : null,
        staleAfterMs: BADGE_STALE_THRESHOLD_MS,
        now,
    });
    card.append(image);

    const row = document.createElement('div');
    row.className = 'camera-card-row';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'camera-card-name';
    name.textContent = camera.name;
    const location = document.createElement('div');
    location.className = 'camera-card-location';
    location.textContent = camera.location;
    info.append(name, location);

    const link = document.createElement('a');
    link.className = 'camera-card-link';
    link.href = `#/cameras/${camera.camera_id}`;
    link.textContent = t('cameras.fullscreenLink');

    row.append(info, link);
    card.append(row);

    return card;
}

export function render(container: HTMLElement): () => void {
    const releaseStatus = claimPageStatus();

    const wrapper = document.createElement('div');
    wrapper.className = 'cameras-page';

    const errorSlot = document.createElement('div');
    const grid = document.createElement('div');
    grid.className = 'cameras-grid';
    wrapper.append(errorSlot, grid);
    container.append(wrapper);

    const reportFreshness = createFreshnessReporter(CAMERAS_POLL_INTERVAL_MS);

    const disposeGridEffect = effect(() => {
        const state = camerasResource.state.get();
        reportFreshness(state);

        const all = state.status === 'ready' ? state.data.cameras : state.status === 'error' ? (state.lastData?.cameras ?? []) : [];
        // Switched-off cameras are absent here rather than dimmed: the
        // point of the setting is to keep them off this page entirely.
        const cameras = enabledCameras(all, settings.get().disabledCameras);

        errorSlot.innerHTML = '';
        if (state.status === 'error') {
            errorSlot.append(errorBand({ hasStaleData: state.lastData !== undefined }));
        }

        const now = new Date();
        grid.innerHTML = '';
        for (const camera of cameras) {
            grid.append(buildCameraCard(camera, now));
        }
    });

    return function dispose(): void {
        disposeGridEffect();
        // `reportFreshness` never reverts a once-set freshness back to
        // `null` by design (see `resourceStatus.ts`) -- unmounting this
        // page must still zero it out, so a later page never inherits a
        // stale "cameras" freshness value.
        releaseStatus();
        wrapper.remove();
    };
}
