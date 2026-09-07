import { describe, expect, it } from 'vitest';
import type { Camera } from '../../../shared/schemas/camera.js';
import { enabledCameras, isCameraEnabled, withCameraEnabled } from './enabledCameras.js';

function camera(id: string): Camera {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { camera_id: id, name: id, location: 'Sortland', current_image_url: null } as any as Camera;
}

describe('isCameraEnabled', () => {
    it('treats a camera absent from the deny-list as on -- a camera added upstream later must appear on its own', () => {
        expect(isCameraEnabled('brand-new', ['a', 'b'])).toBe(true);
        expect(isCameraEnabled('a', ['a', 'b'])).toBe(false);
        expect(isCameraEnabled('anything', [])).toBe(true);
    });
});

describe('enabledCameras', () => {
    it('drops only the denied ones, keeping the upstream order', () => {
        const list = [camera('a'), camera('b'), camera('c')];

        expect(enabledCameras(list, ['b']).map((c) => c.camera_id)).toEqual(['a', 'c']);
        expect(enabledCameras(list, []).map((c) => c.camera_id)).toEqual(['a', 'b', 'c']);
    });
});

describe('withCameraEnabled', () => {
    it('adds an id when switching off and removes it when switching on', () => {
        expect(withCameraEnabled([], 'a', false)).toEqual(['a']);
        expect(withCameraEnabled(['a', 'b'], 'a', true)).toEqual(['b']);
    });

    it('never duplicates an id, however often the same state is written', () => {
        expect(withCameraEnabled(['a'], 'a', false)).toEqual(['a']);
        expect(withCameraEnabled(['a', 'a'], 'a', false)).toEqual(['a']);
    });

    it('leaves the other ids alone', () => {
        expect(withCameraEnabled(['a', 'b'], 'c', false).sort()).toEqual(['a', 'b', 'c']);
        expect(withCameraEnabled(['a', 'b'], 'c', true)).toEqual(['a', 'b']);
    });
});
