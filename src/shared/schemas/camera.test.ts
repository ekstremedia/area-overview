import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/cameras.json' with { type: 'json' };
import { CameraListResponseSchema, CameraSchema } from './camera.js';
import { omitKey } from './test-utils.js';

describe('CameraListResponseSchema', () => {
    it('parses the recorded fixture', () => {
        expect(() => CameraListResponseSchema.parse(fixture)).not.toThrow();
    });

    it('rejects a fixture missing the required cached_at field', () => {
        const withoutCachedAt = omitKey(fixture, 'cached_at');
        const result = CameraListResponseSchema.safeParse(withoutCachedAt);
        expect(result.success).toBe(false);
    });

    it('accepts a fixture with an extra unknown field', () => {
        const result = CameraListResponseSchema.safeParse({ ...fixture, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });
});

describe('CameraSchema', () => {
    it('accepts a camera with current_image_url and latest_video both null', () => {
        const result = CameraSchema.safeParse({
            id: 1,
            camera_id: 'test_01',
            name: 'Test',
            description: null,
            location: 'Test',
            current_image_url: null,
            current_image_updated_at: null,
            latest_video: null,
            video_count: 0,
        });
        expect(result.success).toBe(true);
    });

    it('rejects a camera missing the required name field', () => {
        const first = fixture.cameras[0];
        expect(first).toBeDefined();
        const withoutName = omitKey(first as Record<string, unknown>, 'name');
        const result = CameraSchema.safeParse(withoutName);
        expect(result.success).toBe(false);
    });
});
