import { describe, expect, it, vi } from 'vitest';
import type { Camera } from '../../../shared/schemas/camera.js';
import { buildPopupContent } from './popup.js';

function camera(overrides: Partial<Camera> = {}): Camera {
    return {
        id: 268,
        camera_id: 'sigerfjordveien_01',
        name: 'Sigerfjord',
        description: null,
        location: 'Sigerfjordveien',
        current_image_url: 'https://example.test/current.jpg',
        current_image_updated_at: '2026-09-05T12:00:00Z',
        latest_video: null,
        video_count: 0,
        ...overrides,
    };
}

describe('buildPopupContent', () => {
    it('renders the camera name, a formatted image age, the image, location, and an open-camera link', () => {
        const now = new Date('2026-09-05T12:02:00Z'); // 2 minutes after current_image_updated_at
        const root = buildPopupContent(camera(), { onClose: vi.fn() }, now);

        expect(root.querySelector('.camera-popup-name')?.textContent).toBe('Sigerfjord');
        expect(root.querySelector('.camera-popup-age')?.textContent).toBe('2 min 0 s');

        const img = root.querySelector<HTMLImageElement>('.camera-popup-image img');
        expect(img).not.toBeNull();
        expect(img?.src).toBe('https://example.test/current.jpg');
        // `.halftone` must be on the wrapper, never the <img> itself: its
        // dot-overlay is a `::after` pseudo-element, which cannot render on a
        // replaced element like `<img>` in any browser.
        expect(img?.classList.contains('halftone')).toBe(false);
        expect(root.querySelector('.camera-popup-image.halftone')).not.toBeNull();
        expect(root.querySelector('.camera-popup-no-image')).toBeNull();

        expect(root.querySelector('.camera-popup-location')?.textContent).toBe('Sigerfjordveien');

        const link = root.querySelector<HTMLAnchorElement>('.camera-popup-link');
        expect(link?.getAttribute('href')).toBe('#/cameras/sigerfjordveien_01');
    });

    it('shows a "no image yet" message instead of a broken <img> when current_image_url is null', () => {
        const root = buildPopupContent(camera({ current_image_url: null, current_image_updated_at: null }), { onClose: vi.fn() });

        expect(root.querySelector('.camera-popup-image img')).toBeNull();
        expect(root.querySelector('.camera-popup-no-image')).not.toBeNull();
        expect(root.querySelector('.camera-popup-age')).toBeNull(); // no image, so no image-age line either
    });

    it('falls back to the "no image yet" message when a non-null image URL fails to load', () => {
        const root = buildPopupContent(camera(), { onClose: vi.fn() });

        const img = root.querySelector<HTMLImageElement>('.camera-popup-image img');
        expect(img).not.toBeNull();
        expect(root.querySelector('.camera-popup-no-image')).toBeNull();

        img?.dispatchEvent(new Event('error'));

        expect(root.querySelector('.camera-popup-image img')).toBeNull();
        expect(root.querySelector('.camera-popup-no-image')).not.toBeNull();
        expect(root.querySelector('.camera-popup-image.halftone')).toBeNull();
    });

    it('calls the injected onClose callback when the close button is clicked (never touches Leaflet directly)', () => {
        const onClose = vi.fn();
        const root = buildPopupContent(camera(), { onClose });

        root.querySelector<HTMLButtonElement>('.camera-popup-close')?.click();

        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
