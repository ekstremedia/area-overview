import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

/**
 * A single recorded timelapse video attached to a camera. Upstream:
 * AppCamerasController.php:44-61.
 */
export const CameraVideoSchema = z.object({
    id: z.number(),
    date: z.string(),
    youtube_id: z.string(),
    daytime_url: z.string(),
    night_url: z.string(),
});

/**
 * A single camera, as returned by `GET /api/app/cameras`. Upstream can
 * legitimately send `current_image_url: null` (no snapshot captured yet)
 * and `latest_video: null` (no timelapse recorded yet), so both are
 * nullable rather than optional.
 */
export const CameraSchema = z.object({
    id: z.number(),
    camera_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    location: z.string(),
    current_image_url: z.string().nullable(),
    current_image_updated_at: IsoTimestampSchema.nullable(),
    latest_video: CameraVideoSchema.nullable(),
    video_count: z.number(),
});

export type Camera = z.infer<typeof CameraSchema>;

/**
 * The wrapper object `GET /api/app/cameras` actually returns -- a bare
 * array is NOT the response shape.
 */
export const CameraListResponseSchema = z.object({
    cameras: z.array(CameraSchema),
    cached_at: IsoTimestampSchema,
});

export type CameraListResponse = z.infer<typeof CameraListResponseSchema>;
