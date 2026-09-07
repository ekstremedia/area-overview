import { describe, expect, it, vi } from 'vitest';
import type { Camera, CameraListResponse } from '../../shared/schemas/camera.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import type { ResourceState } from '../core/resource.js';
import { signal } from '../core/signal.js';

function camera(overrides: Partial<Camera> = {}): Camera {
    return {
        id: 1,
        camera_id: 'sigerfjordveien_01',
        name: 'Sigerfjord',
        description: null,
        location: 'Sigerfjordveien, mot sundet',
        current_image_url: 'https://example.test/current.jpg?v=1725530400',
        current_image_updated_at: '2026-09-05T12:00:00Z',
        latest_video: null,
        video_count: 0,
        ...overrides,
    };
}

const mockCamerasState = signal<ResourceState<CameraListResponse>>({
    status: 'ready',
    data: { cameras: [camera()], cached_at: '2026-09-05T12:00:00Z' },
    fetchedAt: new Date('2026-09-05T12:00:00Z'),
});
vi.mock('../camera-resource.js', () => ({ camerasResource: { state: mockCamerasState }, CAMERAS_POLL_INTERVAL_MS: 30_000 }));

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { render } = await import('./CameraViewerPage.js');

function setHash(hash: string): void {
    location.hash = hash;
}

describe('CameraViewerPage', () => {
    it('renders the camera name, image (cache-buster URL used verbatim) and updated line, cold, with no prior navigation', () => {
        const container = document.createElement('div');
        const dispose = render(container, 'sigerfjordveien_01');

        expect(container.querySelector('.camera-viewer-name')?.textContent).toBe('Sigerfjord');

        const img = container.querySelector<HTMLImageElement>('.camera-viewer-image');
        expect(img).not.toBeNull();
        expect(img?.src).toBe('https://example.test/current.jpg?v=1725530400'); // verbatim, no second query param appended
        // Camera photographs opt out of the design system's newsprint dot
        // screen -- it reads as a dirty grid over a live image (Terje's call).
        expect(img?.classList.contains('halftone')).toBe(false);

        expect(container.querySelector('.camera-viewer-updated-line')?.textContent).toContain('Sigerfjordveien, mot sundet');

        dispose();
    });

    it('closing via the X control navigates back to #/cameras, and no other dismiss mechanism exists', () => {
        setHash('#/cameras/sigerfjordveien_01');
        const container = document.createElement('div');
        const dispose = render(container, 'sigerfjordveien_01');

        const closeButton = container.querySelector<HTMLButtonElement>('.camera-viewer-close');
        expect(closeButton).not.toBeNull();
        closeButton?.click();

        expect(location.hash).toBe('#/cameras');

        dispose();
    });

    it('shows a not-found fallback (never a blank screen) for an unknown cameraId', () => {
        const container = document.createElement('div');
        const dispose = render(container, 'does_not_exist');

        expect(container.querySelector('.camera-viewer-not-found')).not.toBeNull();
        expect(container.querySelector<HTMLAnchorElement>('.camera-viewer-not-found a')?.getAttribute('href')).toBe('#/cameras');
        expect(container.querySelector('.camera-viewer-name')).toBeNull();

        dispose();
    });
});
