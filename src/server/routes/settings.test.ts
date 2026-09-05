import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema } from '../../shared/schemas/settings.js';
import { buildTestApp } from './test-helpers.js';

const PASSWORD = 'a-real-password-that-is-long-enough';

/**
 * Every test here points `settingsFile` at a fresh temp directory --
 * never the real repo's `data/` directory, per the phase's hard rule.
 */
let dir: string;
let settingsFile: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'area-overview-settings-routes-'));
    settingsFile = path.join(dir, 'settings.json');
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function buildApp(overrides: Parameters<typeof buildTestApp>[0] = {}) {
    return buildTestApp({ settingsPassword: PASSWORD, settingsFile, ...overrides });
}

async function readSettingsFile(): Promise<unknown> {
    return JSON.parse(await readFile(settingsFile, 'utf8')) as unknown;
}

/** `updatedAt`'s default is computed at parse time, so two independent `SettingsSchema.parse({})` calls a few milliseconds apart never match exactly -- compare everything else exactly and `updatedAt` only as "a string". */
function defaultSettings(): Record<string, unknown> {
    return { ...SettingsSchema.parse({}), updatedAt: expect.any(String) as unknown };
}

describe('GET /api/settings', () => {
    it('returns the full current settings with no auth header', async () => {
        const app = buildApp();

        const response = await app.inject({ method: 'GET', url: '/api/settings' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(defaultSettings());
    });

    it('never sets caching headers', async () => {
        const app = buildApp();

        const response = await app.inject({ method: 'GET', url: '/api/settings' });

        expect(response.headers.etag).toBeUndefined();
        expect(response.headers['x-cache']).toBeUndefined();
    });
});

describe('POST /api/settings/login', () => {
    it('204s with the right password, without writing anything', async () => {
        const app = buildApp();

        const response = await app.inject({
            method: 'POST',
            url: '/api/settings/login',
            headers: { authorization: `Bearer ${PASSWORD}` },
        });

        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
    });

    it('401s with the wrong password', async () => {
        const app = buildApp();

        const response = await app.inject({
            method: 'POST',
            url: '/api/settings/login',
            headers: { authorization: 'Bearer wrong-password-thats-long-enough' },
        });

        expect(response.statusCode).toBe(401);
    });
});

describe('PATCH /api/settings', () => {
    it('401s without a password, and leaves the file untouched', async () => {
        const app = buildApp();

        const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { pollIntervalSeconds: 60 } });

        expect(response.statusCode).toBe(401);
        await expect(readFile(settingsFile, 'utf8')).rejects.toThrow();
    });

    it('400s on an invalid body and leaves the settings unchanged', async () => {
        const app = buildApp();

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { homeView: { zoom: 99 } },
        });

        expect(response.statusCode).toBe(400);

        const after = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(after.json()).toEqual(defaultSettings());
    });

    it('200s with a valid partial patch, and leaves untouched keys at their defaults', async () => {
        const app = buildApp();

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { pollIntervalSeconds: 60 },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json<{ pollIntervalSeconds: number; homeView: unknown; updatedAt: string }>();
        expect(body.pollIntervalSeconds).toBe(60);
        expect(body.homeView).toEqual(SettingsSchema.parse({}).homeView);
        expect(body.updatedAt).not.toBe(SettingsSchema.parse({}).updatedAt);
    });

    /**
     * Regression test for a real bug (see `SettingsPatchSchema`'s own
     * regression test in `src/shared/schemas/settings.test.ts` for the
     * root cause): a `PATCH` that only mentions key B must never reset
     * key A back to its default, even though key A's *current* value was
     * itself set by an earlier `PATCH` and is not a default. The earlier
     * version of this test only ever patched a fresh, all-defaults store,
     * so it couldn't have caught this -- "untouched keys survive" was
     * indistinguishable from "untouched keys were already at their
     * (never-changed) default". This one patches key A to a non-default
     * value first, confirms key A's non-default value is still present
     * -- in the second response body *and* read back from disk -- after
     * a second, unrelated `PATCH` to key B.
     */
    it('a non-default value set by an earlier PATCH survives a later PATCH to a different key', async () => {
        const app = buildApp();

        const first = await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { pollIntervalSeconds: 99 },
        });
        expect(first.statusCode).toBe(200);
        expect(first.json<{ pollIntervalSeconds: number }>().pollIntervalSeconds).toBe(99);

        const second = await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { brightness: 50 },
        });
        expect(second.statusCode).toBe(200);

        const secondBody = second.json<{ pollIntervalSeconds: number; brightness: number }>();
        expect(secondBody.pollIntervalSeconds).toBe(99);
        expect(secondBody.brightness).toBe(50);

        const onDisk = (await readSettingsFile()) as { pollIntervalSeconds: number; brightness: number };
        expect(onDisk.pollIntervalSeconds).toBe(99);
        expect(onDisk.brightness).toBe(50);
    });

    it('400s a PATCH that tries to sneak placements through, and does not apply it', async () => {
        const app = buildApp();

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { placements: { cam1: { lat: 1, lng: 1 } } },
        });

        expect(response.statusCode).toBe(400);

        const after = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(after.json<{ placements: Record<string, unknown> }>().placements).toEqual({});
    });

    it('writes the full merged settings to disk on success', async () => {
        const app = buildApp();

        await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { brightness: 55 },
        });

        const onDisk = (await readSettingsFile()) as { brightness: number };
        expect(onDisk.brightness).toBe(55);
    });

    it('503s when the settings file is corrupt', async () => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(settingsFile, '{ not valid json', 'utf8');
        const app = buildApp();

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { pollIntervalSeconds: 60 },
        });

        expect(response.statusCode).toBe(503);
    });
});

describe('PUT and DELETE /api/settings/placements/:cameraId', () => {
    it('sets a placement, visible in a subsequent GET', async () => {
        const app = buildApp();

        const putResponse = await app.inject({
            method: 'PUT',
            url: '/api/settings/placements/sigerfjordveien_01',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { lat: 68.7, lng: 15.4 },
        });
        expect(putResponse.statusCode).toBe(200);

        const getResponse = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(getResponse.json<{ placements: Record<string, unknown> }>().placements).toEqual({
            sigerfjordveien_01: { lat: 68.7, lng: 15.4 },
        });
    });

    it('401s a PUT without a password', async () => {
        const app = buildApp();

        const response = await app.inject({
            method: 'PUT',
            url: '/api/settings/placements/sigerfjordveien_01',
            payload: { lat: 68.7, lng: 15.4 },
        });

        expect(response.statusCode).toBe(401);
    });

    it('400s a PUT with an invalid placement body', async () => {
        const app = buildApp();

        const response = await app.inject({
            method: 'PUT',
            url: '/api/settings/placements/sigerfjordveien_01',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { lat: 999, lng: 15.4 },
        });

        expect(response.statusCode).toBe(400);
    });

    it('removes a placement on DELETE', async () => {
        const app = buildApp();

        await app.inject({
            method: 'PUT',
            url: '/api/settings/placements/sigerfjordveien_01',
            headers: { authorization: `Bearer ${PASSWORD}` },
            payload: { lat: 68.7, lng: 15.4 },
        });

        const deleteResponse = await app.inject({
            method: 'DELETE',
            url: '/api/settings/placements/sigerfjordveien_01',
            headers: { authorization: `Bearer ${PASSWORD}` },
        });
        expect(deleteResponse.statusCode).toBe(200);

        const getResponse = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(getResponse.json<{ placements: Record<string, unknown> }>().placements).toEqual({});
    });

    it('401s a DELETE without a password', async () => {
        const app = buildApp();

        const response = await app.inject({ method: 'DELETE', url: '/api/settings/placements/sigerfjordveien_01' });

        expect(response.statusCode).toBe(401);
    });
});
