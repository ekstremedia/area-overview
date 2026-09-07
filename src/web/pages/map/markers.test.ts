/**
 * Pure-function tests for `computeMarkerData`/`diffMarkers` -- no mocking
 * needed, since these take plain data in and return plain data out. See
 * `markers.reactive.test.ts` for the `markerData` computed's own
 * reactivity, which needs `camerasResource`/`settings` mocked from the
 * top of that file (not mixed in here -- see that file's doc comment for
 * why `vi.resetModules()` doesn't belong in the same file as an
 * unmocked import of this module).
 */
import { describe, expect, it } from 'vitest';
import type { Camera } from '../../../shared/schemas/camera.js';
import { computeMarkerData, diffMarkers } from './markers.js';

function camera(overrides: Partial<Camera> = {}): Camera {
    return {
        id: 1,
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

describe('computeMarkerData', () => {
    it('places a camera with a matching entry in placements, and skips one without', () => {
        const placed = camera({ camera_id: 'a' });
        const unplaced = camera({ camera_id: 'b', name: 'Unplaced cam' });

        const result = computeMarkerData([placed, unplaced], { a: { lat: 68.7, lng: 15.4 } });

        expect(result.placed).toEqual([{ cameraId: 'a', camera: placed, lat: 68.7, lng: 15.4 }]);
        expect(result.unplaced).toEqual([unplaced]);
    });

    it('leaves a switched-off camera out of both placed and unplaced', () => {
        const off = camera({ camera_id: 'a' });
        const on = camera({ camera_id: 'b', name: 'Still on' });

        const result = computeMarkerData([off, on], { a: { lat: 68.7, lng: 15.4 }, b: { lat: 68.8, lng: 15.5 } }, ['a']);

        expect(result.placed).toEqual([{ cameraId: 'b', camera: on, lat: 68.8, lng: 15.5 }]);
        // And not in `unplaced` either: that list feeds the "N cameras
        // without placement" nag, and nagging about a camera the viewer
        // deliberately switched off is exactly backwards.
        expect(result.unplaced).toEqual([]);
    });

    it('keeps a switched-off camera out of the unplaced nag even when it has no placement', () => {
        const off = camera({ camera_id: 'a' });

        expect(computeMarkerData([off], {}, ['a']).unplaced).toEqual([]);
    });

    it('places nothing and reports every camera as unplaced when placements is empty', () => {
        const cameras = [camera({ camera_id: 'a' }), camera({ camera_id: 'b' })];

        const result = computeMarkerData(cameras, {});

        expect(result.placed).toEqual([]);
        expect(result.unplaced).toEqual(cameras);
    });
});

describe('diffMarkers', () => {
    it('adds every descriptor when there is no previous state', () => {
        const a = { cameraId: 'a', camera: camera({ camera_id: 'a' }), lat: 1, lng: 2 };

        const diff = diffMarkers(new Map(), [a]);

        expect(diff).toEqual({ toAdd: [a], toUpdate: [], toRemove: [] });
    });

    it('produces an empty diff when nothing changed', () => {
        const a = { cameraId: 'a', camera: camera({ camera_id: 'a' }), lat: 1, lng: 2 };
        const previous = new Map([['a', a]]);

        // A fresh poll's response is a *new* object graph even when nothing
        // about the camera actually changed -- diffing must compare by value,
        // not by reference, or every poll would look like an update.
        const aAgain = { cameraId: 'a', camera: camera({ camera_id: 'a' }), lat: 1, lng: 2 };

        const diff = diffMarkers(previous, [aAgain]);

        expect(diff).toEqual({ toAdd: [], toUpdate: [], toRemove: [] });
    });

    it('reports a moved placement as an update, not an add+remove', () => {
        const a = { cameraId: 'a', camera: camera({ camera_id: 'a' }), lat: 1, lng: 2 };
        const previous = new Map([['a', a]]);
        const moved = { cameraId: 'a', camera: camera({ camera_id: 'a' }), lat: 5, lng: 6 };

        const diff = diffMarkers(previous, [moved]);

        expect(diff).toEqual({ toAdd: [], toUpdate: [moved], toRemove: [] });
    });

    it('reports a changed camera image/name as an update', () => {
        const a = { cameraId: 'a', camera: camera({ camera_id: 'a', current_image_url: 'https://example.test/old.jpg' }), lat: 1, lng: 2 };
        const previous = new Map([['a', a]]);
        const updated = { cameraId: 'a', camera: camera({ camera_id: 'a', current_image_url: 'https://example.test/new.jpg' }), lat: 1, lng: 2 };

        const diff = diffMarkers(previous, [updated]);

        expect(diff).toEqual({ toAdd: [], toUpdate: [updated], toRemove: [] });
    });

    it('reports a camera dropped from the next list (removed or unplaced) as a removal', () => {
        const a = { cameraId: 'a', camera: camera({ camera_id: 'a' }), lat: 1, lng: 2 };
        const b = { cameraId: 'b', camera: camera({ camera_id: 'b' }), lat: 3, lng: 4 };
        const previous = new Map([
            ['a', a],
            ['b', b],
        ]);

        const diff = diffMarkers(previous, [a]);

        expect(diff).toEqual({ toAdd: [], toUpdate: [], toRemove: ['b'] });
    });

    it('handles an add, an update and a removal together in one diff', () => {
        const a = { cameraId: 'a', camera: camera({ camera_id: 'a' }), lat: 1, lng: 2 };
        const b = { cameraId: 'b', camera: camera({ camera_id: 'b' }), lat: 3, lng: 4 };
        const previous = new Map([
            ['a', a],
            ['b', b],
        ]);

        const movedA = { cameraId: 'a', camera: camera({ camera_id: 'a' }), lat: 9, lng: 9 };
        const newC = { cameraId: 'c', camera: camera({ camera_id: 'c' }), lat: 7, lng: 7 };

        const diff = diffMarkers(previous, [movedA, newC]);

        expect(diff.toAdd).toEqual([newC]);
        expect(diff.toUpdate).toEqual([movedA]);
        expect(diff.toRemove).toEqual(['b']);
    });
});
