import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSchema } from '../../shared/schemas/settings.js';
import { SettingsStore, SettingsWritesRefusedError } from './store.js';

/**
 * Every test here uses a fresh temp directory -- never the real repo's
 * `data/` directory, per the phase's hard rule against touching it.
 */
let dir: string;
let settingsFile: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'area-overview-settings-store-'));
    settingsFile = path.join(dir, 'settings.json');
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function silentLogger(): { error: ReturnType<typeof vi.fn<(message: string) => void>> } {
    return { error: vi.fn(() => undefined) };
}

/** `updatedAt`'s default is computed at parse time, so two independent `SettingsSchema.parse({})` calls a few milliseconds apart never match exactly -- compare everything else exactly and `updatedAt` only as "a string". */
function defaultSettings(): Record<string, unknown> {
    return { ...SettingsSchema.parse({}), updatedAt: expect.any(String) as unknown };
}

describe('SettingsStore.load', () => {
    it('populates full defaults when the file is missing', async () => {
        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();

        expect(store.get()).toEqual(defaultSettings());
    });

    it('allows writes after loading a missing file', async () => {
        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();

        await expect(store.patch({ pollIntervalSeconds: 60 })).resolves.toMatchObject({ pollIntervalSeconds: 60 });
    });

    it('loads a valid existing file', async () => {
        const onDisk = { ...SettingsSchema.parse({}), pollIntervalSeconds: 120 };
        await writeFile(settingsFile, JSON.stringify(onDisk), 'utf8');

        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();

        expect(store.get().pollIntervalSeconds).toBe(120);
    });

    it('preserves unknown top-level keys through a subsequent write', async () => {
        const onDisk = { ...SettingsSchema.parse({}), someFutureKey: 'keep-me' };
        await writeFile(settingsFile, JSON.stringify(onDisk), 'utf8');

        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();

        await store.patch({ pollIntervalSeconds: 45 });

        const written: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
        expect(written).toMatchObject({ someFutureKey: 'keep-me', pollIntervalSeconds: 45 });
    });

    it('treats unparseable JSON as corrupt: defaults served, writes refused', async () => {
        await writeFile(settingsFile, '{ this is not json', 'utf8');
        const logger = silentLogger();

        const store = new SettingsStore(settingsFile, { logger });
        await store.load();

        expect(store.get()).toEqual(defaultSettings());
        expect(logger.error).toHaveBeenCalledOnce();
        await expect(store.patch({ pollIntervalSeconds: 60 })).rejects.toBeInstanceOf(SettingsWritesRefusedError);
    });

    it('treats schema-invalid JSON as corrupt: defaults served, writes refused', async () => {
        await writeFile(settingsFile, JSON.stringify({ pollIntervalSeconds: 'not-a-number' }), 'utf8');
        const logger = silentLogger();

        const store = new SettingsStore(settingsFile, { logger });
        await store.load();

        expect(store.get()).toEqual(defaultSettings());
        expect(logger.error).toHaveBeenCalledOnce();
        await expect(store.setPlacement('cam1', { lat: 1, lng: 1 })).rejects.toBeInstanceOf(SettingsWritesRefusedError);
    });

    it('does not modify the corrupt file on disk when a write is attempted', async () => {
        const corrupt = '{ this is not json';
        await writeFile(settingsFile, corrupt, 'utf8');

        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();

        await expect(store.patch({ pollIntervalSeconds: 60 })).rejects.toThrow();

        expect(await readFile(settingsFile, 'utf8')).toBe(corrupt);
    });
});

describe('SettingsStore.patch', () => {
    it('is a partial update: untouched keys survive', async () => {
        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();

        await store.patch({ pollIntervalSeconds: 99 });
        const result = await store.patch({ brightness: 50 });

        expect(result.pollIntervalSeconds).toBe(99);
        expect(result.brightness).toBe(50);
    });

    it('bumps updatedAt on every write', async () => {
        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();
        const before = store.get().updatedAt;

        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await store.patch({ pollIntervalSeconds: 15 });

        expect(result.updatedAt).not.toBe(before);
    });

    it('two concurrent patches with different keys both survive', async () => {
        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();

        // Writes are strictly sequential (see `SettingsStore`'s
        // `writeChain` doc comment): the first call's own return value only
        // reflects its own patch, since it resolves before the second call
        // even starts merging. What matters is that the second call's
        // return value -- and the store's final state -- carry *both*
        // patches, proving the second merge composed onto the first's
        // already-applied result rather than a stale snapshot from before
        // it ran.
        const [a, b] = await Promise.all([store.patch({ pollIntervalSeconds: 77 }), store.patch({ brightness: 42 })]);

        expect(a.pollIntervalSeconds).toBe(77);
        expect(b.pollIntervalSeconds).toBe(77);
        expect(b.brightness).toBe(42);
        expect(store.get()).toMatchObject({ pollIntervalSeconds: 77, brightness: 42 });

        const written: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
        expect(written).toMatchObject({ pollIntervalSeconds: 77, brightness: 42 });
    });
});

describe('SettingsStore.setPlacement', () => {
    it('sets and then removes a placement', async () => {
        const store = new SettingsStore(settingsFile, { logger: silentLogger() });
        await store.load();

        const withPlacement = await store.setPlacement('cam1', { lat: 68.7, lng: 15.4 });
        expect(withPlacement.placements.cam1).toEqual({ lat: 68.7, lng: 15.4 });

        const withoutPlacement = await store.setPlacement('cam1', null);
        expect(withoutPlacement.placements.cam1).toBeUndefined();
    });
});

describe('SettingsStore atomic write', () => {
    it('leaves the previous file content intact when rename fails', async () => {
        const goodSettings = { ...SettingsSchema.parse({}), pollIntervalSeconds: 200 };
        await writeFile(settingsFile, JSON.stringify(goodSettings), 'utf8');

        const store = new SettingsStore(settingsFile, {
            logger: silentLogger(),
            fs: {
                rename: vi.fn().mockRejectedValue(new Error('simulated rename failure')),
            },
        });
        await store.load();

        await expect(store.patch({ pollIntervalSeconds: 1 })).rejects.toThrow('simulated rename failure');

        const onDisk: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
        expect(onDisk).toMatchObject({ pollIntervalSeconds: 200 });
        expect(store.get().pollIntervalSeconds).toBe(200);
    });

    it('recovers on the next write once rename succeeds again', async () => {
        const goodSettings = { ...SettingsSchema.parse({}), pollIntervalSeconds: 200 };
        await writeFile(settingsFile, JSON.stringify(goodSettings), 'utf8');

        let shouldFail = true;
        const store = new SettingsStore(settingsFile, {
            logger: silentLogger(),
            fs: {
                rename: vi.fn().mockImplementation(async (from: string, to: string) => {
                    if (shouldFail) {
                        throw new Error('simulated rename failure');
                    }
                    const { rename } = await import('node:fs/promises');
                    return rename(from, to);
                }),
            },
        });
        await store.load();

        await expect(store.patch({ pollIntervalSeconds: 1 })).rejects.toThrow();

        shouldFail = false;
        await expect(store.patch({ pollIntervalSeconds: 2 })).resolves.toMatchObject({ pollIntervalSeconds: 2 });

        const onDisk: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
        expect(onDisk).toMatchObject({ pollIntervalSeconds: 2 });
    });
});
