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
        current_image_url: 'https://example.test/current.jpg',
        current_image_updated_at: '2026-09-05T12:00:00Z',
        latest_video: null,
        video_count: 0,
        ...overrides,
    };
}

const mockCamerasState = signal<ResourceState<CameraListResponse>>({ status: 'idle' });
vi.mock('../camera-resource.js', () => ({ camerasResource: { state: mockCamerasState }, CAMERAS_POLL_INTERVAL_MS: 30_000 }));

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { render } = await import('./CamerasPage.js');
const { pageLocalityOverride, pageAttribution, pageFreshness } = await import('../shell/page-status.js');

describe('CamerasPage', () => {
    it('renders a card per camera, cold, with no prior navigation', () => {
        mockCamerasState.set({
            status: 'ready',
            data: { cameras: [camera(), camera({ camera_id: 'spjutvika_01', name: 'Spjutvika' })], cached_at: '2026-09-05T12:00:00Z' },
            fetchedAt: new Date('2026-09-05T12:00:00Z'),
        });
        const container = document.createElement('div');
        const dispose = render(container);

        const cards = container.querySelectorAll('.camera-card');
        expect(cards).toHaveLength(2);
        expect(container.querySelector('.camera-card-name')?.textContent).toBe('Sigerfjord');
        expect(container.querySelector<HTMLAnchorElement>('.camera-card-link')?.getAttribute('href')).toBe('#/cameras/sigerfjordveien_01');

        dispose();
    });

    it('reports the live camera count in words to the masthead, and clears it on dispose', () => {
        mockCamerasState.set({
            status: 'ready',
            data: { cameras: [camera(), camera({ camera_id: 'b' })], cached_at: '2026-09-05T12:00:00Z' },
            fetchedAt: new Date('2026-09-05T12:00:00Z'),
        });
        const container = document.createElement('div');
        const dispose = render(container);

        expect(pageLocalityOverride.get()).toBe('To kameraer');

        dispose();
        expect(pageLocalityOverride.get()).toBeNull();
    });

    it('mutes a card whose image is missing, and mutes one whose image is many days old', () => {
        mockCamerasState.set({
            status: 'ready',
            data: {
                cameras: [
                    camera({ camera_id: 'fresh', current_image_updated_at: '2026-09-05T11:59:00Z' }),
                    camera({ camera_id: 'no_image', current_image_url: null, current_image_updated_at: null }),
                    camera({ camera_id: 'stale', current_image_updated_at: '2026-08-01T00:00:00Z' }),
                ],
                cached_at: '2026-09-05T12:00:00Z',
            },
            fetchedAt: new Date('2026-09-05T12:00:00Z'),
        });
        const container = document.createElement('div');
        const dispose = render(container);

        const cards = [...container.querySelectorAll('.camera-card')];
        expect(cards[0]?.classList.contains('camera-card--muted')).toBe(false);
        expect(cards[1]?.classList.contains('camera-card--muted')).toBe(true);
        expect(cards[2]?.classList.contains('camera-card--muted')).toBe(true);

        dispose();
    });

    it('shows an error band when the resource errors, using stale data alongside it when available', () => {
        mockCamerasState.set({
            status: 'error',
            error: new Error('boom'),
            lastData: { cameras: [camera()], cached_at: '2026-09-05T12:00:00Z' },
        });
        const container = document.createElement('div');
        const dispose = render(container);

        expect(container.querySelector('.error-band')).not.toBeNull();
        expect(container.querySelectorAll('.camera-card')).toHaveLength(1); // stale data still shown

        dispose();
    });

    it('shows an error band with no cards when the resource errors with no prior data at all', () => {
        mockCamerasState.set({ status: 'error', error: new Error('boom') });
        const container = document.createElement('div');
        const dispose = render(container);

        expect(container.querySelector('.error-band')).not.toBeNull();
        expect(container.querySelectorAll('.camera-card')).toHaveLength(0);

        dispose();
    });

    it('sets and clears page attribution and freshness on mount/unmount', () => {
        mockCamerasState.set({
            status: 'ready',
            data: { cameras: [camera()], cached_at: '2026-09-05T12:00:00Z' },
            fetchedAt: new Date('2026-09-05T12:00:00Z'),
        });
        const container = document.createElement('div');
        const dispose = render(container);

        expect(pageAttribution.get()).toBe('Bilder: nesthus.no');
        expect(pageFreshness.get()).toEqual({ fetchedAt: new Date('2026-09-05T12:00:00Z'), intervalMs: 30_000 });

        dispose();
        expect(pageAttribution.get()).toBeNull();
        expect(pageFreshness.get()).toBeNull();
    });
});
