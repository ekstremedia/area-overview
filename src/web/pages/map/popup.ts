/**
 * The camera marker popup (artboard 01): a 328px-wide card, name + image
 * age, a 44px close control, the camera's current image (or a "no image
 * yet" message -- `current_image_url` can legitimately be `null`, and
 * this must never render a broken `<img>`), the upstream `location` text,
 * and an "Open camera →" link to `#/cameras/<camera_id>` (Phase 8 builds
 * that page's content; this phase only wires the link).
 *
 * Built fresh each time a marker's popup opens (see `markers.ts`'s
 * `bindPopup(() => buildPopupContent(...))`), so the age always reflects
 * "now" at open time, and again on every camera-list poll while the
 * popup stays open (`markers.ts` calls `setPopupContent` on an in-place
 * update). No live per-second ticker inside an already-open popup --
 * that's more precision than a 30s-polled age needs.
 */
import type { Camera } from '../../../shared/schemas/camera.js';
import { t } from '../../i18n/index.js';
import { formatAge } from '../../shell/staleness.js';

function imageAgeText(camera: Camera, now: Date): string | undefined {
    if (!camera.current_image_updated_at) return undefined;
    return formatAge(new Date(camera.current_image_updated_at), now);
}

export interface PopupCallbacks {
    /** Called when the popup's own close control is tapped. `MapPage.ts` wires this to `map.closePopup()`; keeping the callback injected (rather than importing Leaflet here) keeps this file Leaflet-free. */
    onClose: () => void;
}

export function buildPopupContent(camera: Camera, callbacks: PopupCallbacks, now: Date = new Date()): HTMLElement {
    const root = document.createElement('div');
    root.className = 'camera-popup';

    const header = document.createElement('div');
    header.className = 'camera-popup-header';

    const titleGroup = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'camera-popup-name';
    name.textContent = camera.name;
    titleGroup.append(name);

    const age = imageAgeText(camera, now);
    if (age) {
        const ageEl = document.createElement('div');
        ageEl.className = 'camera-popup-age';
        ageEl.textContent = age;
        titleGroup.append(ageEl);
    }

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'camera-popup-close';
    closeButton.textContent = '✕';
    closeButton.setAttribute('aria-label', t('map.popupClose'));
    closeButton.addEventListener('click', callbacks.onClose);

    header.append(titleGroup, closeButton);
    root.append(header);

    const imageWrap = document.createElement('div');
    imageWrap.className = 'camera-popup-image';

    function renderNoImageFallback(): void {
        imageWrap.replaceChildren();
        const noImage = document.createElement('div');
        noImage.className = 'camera-popup-no-image';
        noImage.textContent = t('map.noImage');
        imageWrap.append(noImage);
    }

    if (camera.current_image_url) {
        // No `.halftone` here either -- see `ImageWithAge.ts` for why camera
        // imagery opts out of the newsprint dot screen.
        const img = document.createElement('img');
        img.src = camera.current_image_url;
        img.alt = t('map.cameraImageAlt', { name: camera.name });
        // A non-null URL can still fail to load (404, timeout, etc.) -- this must
        // never show the browser's broken-image icon inside the popup card, so
        // fall back to the same "no image" state used for a null URL.
        img.addEventListener('error', renderNoImageFallback);
        imageWrap.append(img);
    } else {
        renderNoImageFallback();
    }
    root.append(imageWrap);

    const footer = document.createElement('div');
    footer.className = 'camera-popup-footer';

    const location = document.createElement('div');
    location.className = 'camera-popup-location';
    location.textContent = camera.location;

    const link = document.createElement('a');
    link.className = 'camera-popup-link';
    link.href = `#/cameras/${camera.camera_id}`;
    link.textContent = t('map.openCamera');

    footer.append(location, link);
    root.append(footer);

    return root;
}
