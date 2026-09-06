import { describe, expect, it } from 'vitest';
import { MapConfigResponseSchema } from '../../shared/schemas/map-config.js';
import { buildTestApp } from './test-helpers.js';

describe('GET /api/map-config', () => {
    it('responds with an empty cartoApiKey when unconfigured', async () => {
        const app = buildTestApp({ cartoApiKey: '' });

        const response = await app.inject({ method: 'GET', url: '/api/map-config' });

        expect(response.statusCode).toBe(200);
        const body = MapConfigResponseSchema.parse(response.json());
        expect(body).toEqual({ cartoApiKey: '' });
    });

    it('responds with the configured cartoApiKey', async () => {
        const app = buildTestApp({ cartoApiKey: 'a-test-carto-key' });

        const response = await app.inject({ method: 'GET', url: '/api/map-config' });

        expect(response.statusCode).toBe(200);
        const body = MapConfigResponseSchema.parse(response.json());
        expect(body).toEqual({ cartoApiKey: 'a-test-carto-key' });
    });
});
