import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSchema } from '../../shared/schemas/settings.js';

const TEST_PASSWORD = 'a-test-password-used-only-in-this-session';

vi.mock('./session.js', () => ({
    authHeaders: vi.fn(() => ({ Authorization: `Bearer ${TEST_PASSWORD}` })),
    logout: vi.fn(),
}));

const { createSettingsStore } = await import('./sharedStore.js');
const session = await import('./session.js');

function jsonResponse(status: number, body: unknown): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('createSettingsStore', () => {
    it('starts at schema defaults and adopts the first poll response', async () => {
        const settings = SettingsSchema.parse({ brightness: 42 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, settings)));

        const store = createSettingsStore();
        expect(store.settings.get().brightness).toBe(100); // schema default before any load

        await vi.advanceTimersByTimeAsync(0);
        expect(store.settings.get().brightness).toBe(42);

        store.dispose();
    });

    it('patchSettings applies optimistically before the network call resolves', async () => {
        const initial = SettingsSchema.parse({ brightness: 50 });
        let resolvePatch!: (r: Response) => void;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, initial)) // initial GET
            .mockImplementationOnce(
                () =>
                    new Promise<Response>((resolve) => {
                        resolvePatch = resolve;
                    }),
            );
        vi.stubGlobal('fetch', fetchMock);

        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);
        expect(store.settings.get().brightness).toBe(50);

        const writePromise = store.patchSettings({ brightness: 80 });
        expect(store.settings.get().brightness).toBe(80); // optimistic, before the PATCH resolves

        resolvePatch(jsonResponse(200, SettingsSchema.parse({ brightness: 80 })));
        const result = await writePromise;
        expect(result.ok).toBe(true);
        expect(store.settings.get().brightness).toBe(80);

        store.dispose();
    });

    it('rolls back to the pre-edit value and returns an error on a failed PATCH', async () => {
        const initial = SettingsSchema.parse({ brightness: 50 });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, initial))
            .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
        vi.stubGlobal('fetch', fetchMock);

        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        const result = await store.patchSettings({ brightness: 80 });

        expect(result.ok).toBe(false);
        expect(store.settings.get().brightness).toBe(50); // rolled back

        store.dispose();
    });

    it('on a 401, rolls back and logs the device out', async () => {
        const initial = SettingsSchema.parse({ brightness: 50 });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, initial))
            .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }));
        vi.stubGlobal('fetch', fetchMock);

        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        const result = await store.patchSettings({ brightness: 80 });

        expect(result.ok).toBe(false);
        expect(store.settings.get().brightness).toBe(50);
        expect(session.logout).toHaveBeenCalledTimes(1);

        store.dispose();
    });

    it('setPlacement PUTs a placement optimistically and rolls back on failure', async () => {
        const initial = SettingsSchema.parse({});
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, initial))
            .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
        vi.stubGlobal('fetch', fetchMock);

        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);

        const writePromise = store.setPlacement('cam-1', { lat: 68.7, lng: 15.4 });
        expect(store.settings.get().placements['cam-1']).toEqual({ lat: 68.7, lng: 15.4 });

        const result = await writePromise;
        expect(result.ok).toBe(false);
        expect(store.settings.get().placements['cam-1']).toBeUndefined();

        store.dispose();
    });

    it('setPlacement DELETE clears a placement', async () => {
        const initial = SettingsSchema.parse({ placements: { 'cam-1': { lat: 68.7, lng: 15.4 } } });
        const afterDelete = SettingsSchema.parse({ placements: {} });
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, initial)).mockResolvedValueOnce(jsonResponse(200, afterDelete));
        vi.stubGlobal('fetch', fetchMock);

        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);
        expect(store.settings.get().placements['cam-1']).toBeDefined();

        const result = await store.setPlacement('cam-1', null);
        expect(result.ok).toBe(true);
        expect(store.settings.get().placements['cam-1']).toBeUndefined();

        const [, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(deleteInit.method).toBe('DELETE');

        store.dispose();
    });

    it('pending-edit-vs-poll: an in-flight write to field A survives a concurrent poll response that changes both A and B, then settles once the write resolves', async () => {
        const initial = SettingsSchema.parse({ brightness: 50, idleResetSeconds: 300 });
        let resolvePatch!: (r: Response) => void;
        const fetchMock = vi
            .fn()
            // initial GET
            .mockResolvedValueOnce(jsonResponse(200, initial))
            // the in-flight PATCH -- resolves late, on purpose
            .mockImplementationOnce(
                () =>
                    new Promise<Response>((resolve) => {
                        resolvePatch = resolve;
                    }),
            );
        vi.stubGlobal('fetch', fetchMock);

        const store = createSettingsStore({ pollIntervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(store.settings.get()).toMatchObject({ brightness: 50, idleResetSeconds: 300 });

        // Start an in-flight write to `brightness` (field A).
        const writePromise = store.patchSettings({ brightness: 90 });
        expect(store.settings.get().brightness).toBe(90); // local, in-flight value

        // A poll response arrives mid-flight, simulating a concurrent change
        // from another device: a *different* brightness (field A) and a
        // changed idleResetSeconds (field B).
        const concurrentPoll = SettingsSchema.parse({ brightness: 65, idleResetSeconds: 120 });
        fetchMock.mockResolvedValueOnce(jsonResponse(200, concurrentPoll));
        await vi.advanceTimersByTimeAsync(1000);

        // Field A (brightness) must still show the local in-flight value...
        expect(store.settings.get().brightness).toBe(90);
        // ...while field B (idleResetSeconds) updates immediately from the poll.
        expect(store.settings.get().idleResetSeconds).toBe(120);

        // Now let the in-flight write for A resolve with its own authoritative value.
        resolvePatch(jsonResponse(200, SettingsSchema.parse({ brightness: 90, idleResetSeconds: 120 })));
        const result = await writePromise;
        expect(result.ok).toBe(true);
        expect(store.settings.get().brightness).toBe(90);
        expect(store.settings.get().idleResetSeconds).toBe(120);

        store.dispose();
    });

    it('two overlapping writes to the same field: the first settling must not un-pend the field while the second is still in flight', async () => {
        const initial = SettingsSchema.parse({ brightness: 50 });
        let resolveFirstWrite!: (r: Response) => void;
        let resolveSecondWrite!: (r: Response) => void;
        const fetchMock = vi
            .fn()
            // initial GET
            .mockResolvedValueOnce(jsonResponse(200, initial))
            // first write to `brightness` -- resolves first, but should NOT
            // clear the pending mark while the second write is still in flight
            .mockImplementationOnce(
                () =>
                    new Promise<Response>((resolve) => {
                        resolveFirstWrite = resolve;
                    }),
            )
            // second, overlapping write to `brightness`
            .mockImplementationOnce(
                () =>
                    new Promise<Response>((resolve) => {
                        resolveSecondWrite = resolve;
                    }),
            );
        vi.stubGlobal('fetch', fetchMock);

        const store = createSettingsStore({ pollIntervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(store.settings.get().brightness).toBe(50);

        const firstWrite = store.patchSettings({ brightness: 60 });
        const secondWrite = store.patchSettings({ brightness: 70 });
        expect(store.settings.get().brightness).toBe(70); // second write's optimistic value wins locally

        // The first write settles now, while the second is still in flight.
        // A stale poll response landing right after must not clobber the
        // second write's still-pending optimistic value.
        fetchMock.mockResolvedValueOnce(jsonResponse(200, SettingsSchema.parse({ brightness: 60 })));
        resolveFirstWrite(jsonResponse(200, SettingsSchema.parse({ brightness: 60 })));
        await firstWrite;
        await vi.advanceTimersByTimeAsync(1000); // let the poll fire and resolve

        expect(store.settings.get().brightness).toBe(70); // still the second write's optimistic value, not the stale poll

        resolveSecondWrite(jsonResponse(200, SettingsSchema.parse({ brightness: 70 })));
        const secondResult = await secondWrite;
        expect(secondResult.ok).toBe(true);
        expect(store.settings.get().brightness).toBe(70);

        store.dispose();
    });

    it('sends the stored password as a Bearer header on every write', async () => {
        const initial = SettingsSchema.parse({});
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, initial)).mockResolvedValueOnce(jsonResponse(200, initial));
        vi.stubGlobal('fetch', fetchMock);

        const store = createSettingsStore();
        await vi.advanceTimersByTimeAsync(0);
        await store.patchSettings({ brightness: 70 });

        const [, patchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect((patchInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_PASSWORD}`);

        store.dispose();
    });
});
