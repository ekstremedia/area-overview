/**
 * The frontend's read side of `GET /api/cameras`. Built on Phase 4's
 * `resource()`, same shape as `settings-resource.ts`. Module-scope
 * singleton, started once on first import -- Phase 6's map page and
 * Phase 8's cameras page both read this same resource, so a camera's
 * poll cadence and cached list are shared rather than each page opening
 * its own duplicate polling loop.
 */
import { err, ok, type Result } from '../shared/result.js';
import { CameraListResponseSchema, type CameraListResponse } from '../shared/schemas/camera.js';
import { resource, type Resource } from './core/resource.js';

/** How often the kiosk re-fetches the camera list from the BFF. */
const CAMERAS_POLL_INTERVAL_MS = 30_000;

async function fetchCameras(): Promise<Result<CameraListResponse>> {
    try {
        const response = await fetch('/api/cameras');
        if (!response.ok) {
            return err({ message: `GET /api/cameras responded ${String(response.status)}` });
        }
        const json: unknown = await response.json();
        const parsed = CameraListResponseSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/cameras returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/cameras', cause });
    }
}

export const camerasResource: Resource<CameraListResponse> = resource(fetchCameras, { intervalMs: CAMERAS_POLL_INTERVAL_MS });
