/**
 * Where an edit lands, depending on whether this device may write to the
 * shared settings. Kept out of `sharedStore.test.ts` because that file
 * mocks the session as permanently logged in to exercise the shared write
 * path; this one drives the login state itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSchema } from '../../shared/schemas/settings.js';

const loggedIn = { value: false };

vi.mock('./session.js', () => ({
    authHeaders: vi.fn(() => ({ Authorization: 'Bearer a-test-password' })),
    logout: vi.fn(),
    isLoggedIn: {
        get: () => loggedIn.value,
    },
}));

const { createSettingsStore } = await import('./sharedStore.js');
const { localOverrides, clearAllLocalOverrides, setLocalOverride } = await import('./localOverrides.js');

function jsonResponse(status: number, body: unknown): Response {
    return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    loggedIn.value = false;
    clearAllLocalOverrides();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearAllLocalOverrides();
});

describe('createSettingsStore -- logged out', () => {
    it('writes an edit to this device instead of the shared settings', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SettingsSchema.parse({ brightness: 100 })));
        vi.stubGlobal('fetch', fetchMock);
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);
        const callsAfterInitialGet = fetchMock.mock.calls.length;

        const result = await store.patchSettings({ brightness: 40 });

        expect(result.ok).toBe(true);
        // No PATCH: a visitor must not be able to move the kiosk.
        expect(fetchMock.mock.calls.length).toBe(callsAfterInitialGet);
        expect(localOverrides.get()).toEqual({ brightness: 40 });

        store.dispose();
    });

    it('shows the edit as the effective value while the shared value stays put', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, SettingsSchema.parse({ brightness: 100 }))));
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        await store.patchSettings({ brightness: 40 });

        expect(store.settings.get().brightness).toBe(40);
        expect(store.serverSettings.get().brightness).toBe(100);

        store.dispose();
    });

    it('keeps the device value when a poll brings a different shared value', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 100 })))
            .mockResolvedValue(jsonResponse(200, SettingsSchema.parse({ brightness: 80 })));
        vi.stubGlobal('fetch', fetchMock);
        const store = createSettingsStore({ pollIntervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(0);
        await store.patchSettings({ brightness: 40 });

        // Terje changes the shared brightness from his own logged-in device.
        await vi.advanceTimersByTimeAsync(1000);

        expect(store.serverSettings.get().brightness).toBe(80);
        expect(store.settings.get().brightness).toBe(40); // this device keeps its own
        store.dispose();
    });

    it('reveals the current shared value the moment an override is cleared', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 100 })))
            .mockResolvedValue(jsonResponse(200, SettingsSchema.parse({ brightness: 80 })));
        vi.stubGlobal('fetch', fetchMock);
        const store = createSettingsStore({ pollIntervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(0);
        await store.patchSettings({ brightness: 40 });
        await vi.advanceTimersByTimeAsync(1000);

        await store.clearOverride('brightness');

        // Not the 100 it was overriding when it was set -- whatever the
        // shared value is *now*.
        expect(store.settings.get().brightness).toBe(80);
        store.dispose();
    });

    it('reports which fields this device has taken over', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, SettingsSchema.parse({}))));
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        await store.patchSettings({ brightness: 40, language: 'en' });

        expect(Object.keys(store.overrides.get()).sort()).toEqual(['brightness', 'language']);

        await store.clearAllOverrides();
        expect(store.overrides.get()).toEqual({});

        store.dispose();
    });

    it('still refuses a camera placement, which is shared content rather than a preference', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, {}));
        vi.stubGlobal('fetch', fetchMock);
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        const result = await store.setPlacement('cam-1', { lat: 68.7, lng: 15.4 });

        expect(result.ok).toBe(false);
        store.dispose();
    });
});

describe('createSettingsStore -- logged in', () => {
    it('writes to the shared settings', async () => {
        loggedIn.value = true;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 100 })))
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 40 })));
        vi.stubGlobal('fetch', fetchMock);
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        await store.patchSettings({ brightness: 40 });

        const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
        expect(patchCall).toBeDefined();
        expect(localOverrides.get()).toEqual({});

        store.dispose();
    });

    it("clears this device's override of a field it has just written to the shared settings", async () => {
        // The case that would otherwise read as the write having failed:
        // Terje logs in on a device he had already customised, sets a new
        // shared value, and sees nothing change because his own override
        // is still masking it.
        setLocalOverride('brightness', 40);
        loggedIn.value = true;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 100 })))
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 70 })));
        vi.stubGlobal('fetch', fetchMock);
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);
        expect(store.settings.get().brightness).toBe(40); // the override is in force

        await store.patchSettings({ brightness: 70 });

        expect(localOverrides.get()).toEqual({});
        expect(store.settings.get().brightness).toBe(70);

        store.dispose();
    });

    it('leaves overrides of other fields alone when writing one field', async () => {
        setLocalOverride('language', 'en');
        loggedIn.value = true;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({})))
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 70 })));
        vi.stubGlobal('fetch', fetchMock);
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        await store.patchSettings({ brightness: 70 });

        expect(localOverrides.get()).toEqual({ language: 'en' });
        store.dispose();
    });

    it("keeps this device's override when the shared write fails", async () => {
        setLocalOverride('brightness', 40);
        loggedIn.value = true;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 100 })))
            .mockResolvedValueOnce(jsonResponse(500, {}));
        vi.stubGlobal('fetch', fetchMock);
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        const result = await store.patchSettings({ brightness: 70 });

        expect(result.ok).toBe(false);
        expect(localOverrides.get()).toEqual({ brightness: 40 });
        store.dispose();
    });

    it('routes by login state at write time, not at construction', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({})))
            .mockResolvedValue(jsonResponse(200, SettingsSchema.parse({ brightness: 70 })));
        vi.stubGlobal('fetch', fetchMock);
        // Built while logged out...
        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        // ...and logged in afterwards, without rebuilding it.
        loggedIn.value = true;
        await store.patchSettings({ brightness: 70 });

        const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
        expect(patchCall).toBeDefined();
        store.dispose();
    });
});
