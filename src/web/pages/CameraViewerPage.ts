/**
 * The full-screen camera viewer (artboard 06), route `#/cameras/:id`.
 * Covers the *entire* viewport -- masthead, tabs and footer included --
 * with `position: fixed; inset: 0`, since the artboard shows the image
 * filling the whole 1024x600 area with no chrome visible at all. It's
 * still mounted inside `AppShell.ts`'s normal page container (no change
 * to the shell needed): fixed positioning simply escapes that container's
 * normal flow. Sits below the night/brightness overlay's z-index (1000)
 * so night dimming still applies while a camera is open full-screen.
 *
 * Reuses the shared `camerasResource` singleton (see `camera-resource.ts`
 * and `CamerasPage.ts`), so opening the viewer never starts a second poll
 * of the same data.
 *
 * Dismissed by the visible X control only -- tapping it navigates back to
 * `#/cameras`. No swipe-to-dismiss/back-gesture is implemented, deliberately:
 * an accidental swipe must not close a full-screen kiosk view.
 */
import type { Camera } from '../../shared/schemas/camera.js';
import { CAMERAS_POLL_INTERVAL_MS, camerasResource } from '../camera-resource.js';
import { effect } from '../core/signal.js';
import { formatRelative, formatTime, t } from '../i18n/index.js';
import { pageAttribution, pageFreshness } from '../shell/page-status.js';
import { createFreshnessReporter } from '../shell/resourceStatus.js';
import './cameras/cameraViewer.css';

function findCamera(cameras: readonly Camera[], cameraId: string): Camera | undefined {
    return cameras.find((camera) => camera.camera_id === cameraId);
}

export function render(container: HTMLElement, cameraId: string): () => void {
    const root = document.createElement('div');
    root.className = 'camera-viewer';
    container.append(root);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'camera-viewer-close';
    closeButton.textContent = '✕';
    closeButton.setAttribute('aria-label', t('map.popupClose'));
    closeButton.addEventListener('click', () => {
        location.hash = '#/cameras';
    });

    const reportFreshness = createFreshnessReporter(CAMERAS_POLL_INTERVAL_MS);

    const disposeEffect = effect(() => {
        const state = camerasResource.state.get();
        reportFreshness(state);

        const cameras = state.status === 'ready' ? state.data.cameras : state.status === 'error' ? (state.lastData?.cameras ?? []) : [];
        const camera = findCamera(cameras, cameraId);

        root.innerHTML = '';

        if (!camera) {
            const notFound = document.createElement('div');
            notFound.className = 'camera-viewer-not-found';
            const message = document.createElement('p');
            message.textContent = t('cameraViewer.notFound');
            const back = document.createElement('a');
            back.href = '#/cameras';
            back.textContent = t('cameraViewer.backToGrid');
            notFound.append(message, back);
            root.append(notFound);
            return;
        }

        if (camera.current_image_url) {
            const img = document.createElement('img');
            img.className = 'camera-viewer-image';
            img.src = camera.current_image_url;
            img.alt = t('map.cameraImageAlt', { name: camera.name });
            root.append(img);
        }

        // The gradient overlay sits on top of the image (DOM order = paint
        // order here, no z-index needed) so the top/bottom text stays
        // legible over a bright photo.
        const overlay = document.createElement('div');
        overlay.className = 'camera-viewer-overlay';
        root.append(overlay);

        const topBar = document.createElement('div');
        topBar.className = 'camera-viewer-top';
        const titleGroup = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'camera-viewer-label';
        label.textContent = t('cameraViewer.label');
        const name = document.createElement('div');
        name.className = 'camera-viewer-name';
        name.textContent = camera.name;
        titleGroup.append(label, name);
        topBar.append(titleGroup, closeButton);
        root.append(topBar);

        const bottomBar = document.createElement('div');
        bottomBar.className = 'camera-viewer-bottom';

        const ageGroup = document.createElement('div');
        const age = document.createElement('div');
        age.className = 'camera-viewer-age';
        const updatedAt = camera.current_image_updated_at ? new Date(camera.current_image_updated_at) : null;
        age.textContent = updatedAt ? formatRelative(updatedAt) : t('map.noImage');
        const updatedLine = document.createElement('div');
        updatedLine.className = 'camera-viewer-updated-line';
        updatedLine.textContent = updatedAt ? t('cameraViewer.updated', { time: formatTime(updatedAt), location: camera.location }) : camera.location;
        ageGroup.append(age, updatedLine);

        // No credit line: the images are Terje's own (artboard 06 drops it).
        bottomBar.append(ageGroup);
        root.append(bottomBar);
    });

    return function dispose(): void {
        disposeEffect();
        pageFreshness.set(null);
        pageAttribution.set(null);
        root.remove();
    };
}
