/**
 * One place that answers "is this camera switched on?", so the cameras
 * page, the map's markers and the camera count can never disagree about
 * it.
 *
 * `settings.disabledCameras` is a deny-list of camera ids (see its schema
 * doc comment for why a deny-list): everything upstream serves is shown
 * unless it appears there, so a camera added upstream later shows up on
 * its own rather than waiting to be enabled by hand.
 */
import type { Camera } from '../../../shared/schemas/camera.js';
import type { Settings } from '../../../shared/schemas/settings.js';

export function isCameraEnabled(cameraId: string, disabledCameras: Settings['disabledCameras']): boolean {
    return !disabledCameras.includes(cameraId);
}

export function enabledCameras(cameras: readonly Camera[], disabledCameras: Settings['disabledCameras']): Camera[] {
    return cameras.filter((camera) => isCameraEnabled(camera.camera_id, disabledCameras));
}

/** `disabledCameras` with `cameraId` added or removed -- kept here so the settings toggle and any future caller agree on the shape (no duplicates, order irrelevant). */
export function withCameraEnabled(disabledCameras: Settings['disabledCameras'], cameraId: string, enabled: boolean): string[] {
    const without = disabledCameras.filter((id) => id !== cameraId);
    return enabled ? without : [...without, cameraId];
}
