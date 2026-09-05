/**
 * `markerData`'s own reactivity: a `computed()` over both
 * `camerasResource` and `settings`. Mocks both modules from the top of
 * this file (same pattern as `shell/theme.test.ts`), and imports
 * `markers.js` exactly once, so this file never re-imports `core/
 * signal.js` mid-run -- doing that (e.g. via `vi.resetModules()` after an
 * earlier *unmocked* import of `markers.js`, as `markers.test.ts` does)
 * would load a second, independent copy of the tracking-stack module:
 * the mocked `settings`/`camerasResource` signals created against the
 * *first* copy would then never actually register with `markerData`'s
 * `computed()`, which runs its tracking against the *second* copy's
 * module-scope `activeTracker` variable. Signals still read fine across
 * the split (`.get()` just returns a value), but `.set()` silently stops
 * notifying anything -- exactly the bug this file's separation avoids.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CameraListResponse } from '../../../shared/schemas/camera.js';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import type { ResourceState } from '../../core/resource.js';
import { signal } from '../../core/signal.js';

function camera(cameraId: string, name: string) {
    return {
        id: 1,
        camera_id: cameraId,
        name,
        description: null,
        location: 'Somewhere',
        current_image_url: null,
        current_image_updated_at: null,
        latest_video: null,
        video_count: 0,
    };
}

const cameraA = camera('a', 'Camera A');
const cameraB = camera('b', 'Camera B');

const mockCamerasState = signal<ResourceState<CameraListResponse>>({
    status: 'ready',
    data: { cameras: [cameraA, cameraB], cached_at: '2026-09-05T12:00:00Z' },
    fetchedAt: new Date('2026-09-05T12:00:00Z'),
});
vi.mock('../../camera-resource.js', () => ({ camerasResource: { state: mockCamerasState } }));

const mockSettings = signal<Settings>(SettingsSchema.parse({ placements: { a: { lat: 1, lng: 2 } } }));
vi.mock('../../settings-resource.js', () => ({ settings: mockSettings }));

const { markerData } = await import('./markers.js');

describe('markerData', () => {
    it('starts from the initial placements: one placed, one unplaced', () => {
        expect(markerData.get().placed.map((m) => m.cameraId)).toEqual(['a']);
        expect(markerData.get().unplaced.map((c) => c.camera_id)).toEqual(['b']);
    });

    it('moves a camera from unplaced to placed when settings.placements changes, with no new fetch', () => {
        // Same `camerasResource` state throughout -- this is purely a
        // `settings` poll landing with a changed value (e.g. Phase 9's
        // settings UI, or a direct PUT to /api/settings/placements/:id).
        mockSettings.set(SettingsSchema.parse({ placements: { a: { lat: 1, lng: 2 }, b: { lat: 3, lng: 4 } } }));

        expect(
            markerData
                .get()
                .placed.map((m) => m.cameraId)
                .sort(),
        ).toEqual(['a', 'b']);
        expect(markerData.get().unplaced).toEqual([]);
    });

    it('moves a camera from placed to unplaced when its placement is removed', () => {
        mockSettings.set(SettingsSchema.parse({ placements: { a: { lat: 1, lng: 2 } } }));

        expect(markerData.get().placed.map((m) => m.cameraId)).toEqual(['a']);
        expect(markerData.get().unplaced.map((c) => c.camera_id)).toEqual(['b']);
    });

    it('reacts to a camera-list change too (e.g. a camera added/removed upstream)', () => {
        const cameraC = camera('c', 'Camera C');
        mockCamerasState.set({
            status: 'ready',
            data: { cameras: [cameraA, cameraB, cameraC], cached_at: '2026-09-05T12:05:00Z' },
            fetchedAt: new Date('2026-09-05T12:05:00Z'),
        });

        expect(
            markerData
                .get()
                .unplaced.map((c) => c.camera_id)
                .sort(),
        ).toEqual(['b', 'c']);
    });
});
