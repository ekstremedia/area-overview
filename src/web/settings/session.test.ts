import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'area-overview:settings-password';
const TEST_PASSWORD = 'a-test-password-used-only-in-this-session';

beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    vi.unstubAllGlobals();
});

afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
});

function stubFetch(response: Partial<Response> & { status: number }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('login', () => {
    it('stores the password and flips isLoggedIn on a 204', async () => {
        const fetchMock = stubFetch({ status: 204 });
        const { login, isLoggedIn } = await import('./session.js');

        expect(isLoggedIn.get()).toBe(false);
        const result = await login(TEST_PASSWORD);

        expect(result.ok).toBe(true);
        expect(isLoggedIn.get()).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).toBe(TEST_PASSWORD);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_PASSWORD}`);
    });

    it('does not store anything on a 401, and returns an error', async () => {
        stubFetch({ status: 401 });
        const { login, isLoggedIn } = await import('./session.js');

        const result = await login('wrong-password-also-fake');

        expect(result.ok).toBe(false);
        expect(isLoggedIn.get()).toBe(false);
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('does not store anything and returns an error on a network failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const { login, isLoggedIn } = await import('./session.js');

        const result = await login(TEST_PASSWORD);

        expect(result.ok).toBe(false);
        expect(isLoggedIn.get()).toBe(false);
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
});

describe('logout', () => {
    it('clears the stored password and flips isLoggedIn back to false', async () => {
        stubFetch({ status: 204 });
        const { login, logout, isLoggedIn } = await import('./session.js');

        await login(TEST_PASSWORD);
        expect(isLoggedIn.get()).toBe(true);

        logout();

        expect(isLoggedIn.get()).toBe(false);
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
});

describe('authHeaders', () => {
    it('is empty when logged out', async () => {
        const { authHeaders } = await import('./session.js');
        expect(authHeaders()).toEqual({});
    });

    it('carries the Bearer header when logged in', async () => {
        stubFetch({ status: 204 });
        const { login, authHeaders } = await import('./session.js');
        await login(TEST_PASSWORD);
        expect(authHeaders()).toEqual({ Authorization: `Bearer ${TEST_PASSWORD}` });
    });
});

describe('persistence across a simulated reload', () => {
    it('a stored password survives re-importing the module fresh (simulated reload)', async () => {
        stubFetch({ status: 204 });
        const first = await import('./session.js');
        await first.login(TEST_PASSWORD);

        vi.resetModules();
        const second = await import('./session.js');

        expect(second.isLoggedIn.get()).toBe(true);
        expect(second.authHeaders()).toEqual({ Authorization: `Bearer ${TEST_PASSWORD}` });
    });

    it('survives a simulated idle-reset (idle-reset dispatches its own DOM event and never touches the stored password)', async () => {
        stubFetch({ status: 204 });
        const { login, isLoggedIn } = await import('./session.js');
        const { IDLE_RESET_EVENT } = await import('../shell/idle.js');

        await login(TEST_PASSWORD);
        expect(isLoggedIn.get()).toBe(true);

        window.dispatchEvent(new Event(IDLE_RESET_EVENT));

        expect(isLoggedIn.get()).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).toBe(TEST_PASSWORD);
    });
});
