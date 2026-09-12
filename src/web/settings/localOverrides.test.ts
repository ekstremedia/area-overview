import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'area-overview:settings-overrides';

/** Re-imported per test: the module reads `localStorage` once at import time, so each case needs its own fresh instance. */
async function freshModule(): Promise<typeof import('./localOverrides.js')> {
    vi.resetModules();
    return import('./localOverrides.js');
}

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe('localOverrides', () => {
    it('starts empty for a browser that has never set anything', async () => {
        const { localOverrides } = await freshModule();

        expect(localOverrides.get()).toEqual({});
    });

    it('round-trips an override through localStorage', async () => {
        const first = await freshModule();
        first.setLocalOverride('brightness', 40);

        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ brightness: 40 });

        // A reload: a second instance reads back what the first wrote.
        const second = await freshModule();
        expect(second.localOverrides.get()).toEqual({ brightness: 40 });
    });

    it('keeps several overrides side by side', async () => {
        const { localOverrides, setLocalOverride } = await freshModule();

        setLocalOverride('brightness', 40);
        setLocalOverride('language', 'en');

        expect(localOverrides.get()).toEqual({ brightness: 40, language: 'en' });
    });

    it('clears one field without disturbing the others', async () => {
        const { localOverrides, setLocalOverride, clearLocalOverride } = await freshModule();
        setLocalOverride('brightness', 40);
        setLocalOverride('language', 'en');

        clearLocalOverride('brightness');

        expect(localOverrides.get()).toEqual({ language: 'en' });
        // Really gone, not present-but-undefined.
        expect('brightness' in localOverrides.get()).toBe(false);
    });

    it('clears everything at once', async () => {
        const { localOverrides, setLocalOverride, clearAllLocalOverrides } = await freshModule();
        setLocalOverride('brightness', 40);
        setLocalOverride('language', 'en');

        clearAllLocalOverrides();

        expect(localOverrides.get()).toEqual({});
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({});
    });

    it('rejects a value the server would reject, rather than persisting it where nothing would catch it', async () => {
        const { localOverrides, setLocalOverride } = await freshModule();

        // `brightness` is bounded 20..100 by the same schema a PATCH is
        // validated against.
        setLocalOverride('brightness', 5000);

        expect(localOverrides.get()).toEqual({});
    });

    it('falls back to no overrides on corrupt JSON rather than throwing', async () => {
        localStorage.setItem(STORAGE_KEY, '{not json');

        const { localOverrides } = await freshModule();

        expect(localOverrides.get()).toEqual({});
    });

    it('drops the whole object when a stored key no longer validates, rather than half-applying it', async () => {
        // What a renamed or retyped setting leaves behind. Losing a
        // device's overrides is one tap to redo; a half-validated settings
        // object is not recoverable at all.
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ brightness: 40, language: 'klingon' }));

        const { localOverrides } = await freshModule();

        expect(localOverrides.get()).toEqual({});
    });

    it('still updates the in-memory signal when localStorage refuses to store', async () => {
        const { localOverrides, setLocalOverride } = await freshModule();
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });

        setLocalOverride('brightness', 40);

        // This session behaves correctly; it just won't survive a reload.
        expect(localOverrides.get()).toEqual({ brightness: 40 });
        vi.restoreAllMocks();
    });

    it('survives a localStorage that throws on read', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });

        const { localOverrides } = await freshModule();

        expect(localOverrides.get()).toEqual({});
        vi.restoreAllMocks();
    });
});
