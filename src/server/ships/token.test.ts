import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBarentsWatchToken } from './token.js';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createBarentsWatchToken', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fetches and caches a token, returning it without a second fetch while fresh', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'token-1', expires_in: 3600 }));
        const token = createBarentsWatchToken('client-id', 'client-secret', fetchMock);

        const first = await token.getToken();
        const second = await token.getToken();

        expect(first).toEqual({ ok: true, value: 'token-1' });
        expect(second).toEqual({ ok: true, value: 'token-1' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends the documented client-credentials form body', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'token-1', expires_in: 3600 }));
        const token = createBarentsWatchToken('client-id', 'client-secret', fetchMock);

        await token.getToken();

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://id.barentswatch.no/connect/token');
        expect(init.method).toBe('POST');
        const body = new URLSearchParams(init.body as string);
        expect(body.get('client_id')).toBe('client-id');
        expect(body.get('client_secret')).toBe('client-secret');
        expect(body.get('scope')).toBe('ais');
        expect(body.get('grant_type')).toBe('client_credentials');
    });

    it('refreshes once ~80% of expires_in has elapsed', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1', expires_in: 3600 }))
            .mockResolvedValueOnce(jsonResponse({ access_token: 'token-2', expires_in: 3600 }));
        const token = createBarentsWatchToken('client-id', 'client-secret', fetchMock);

        await token.getToken();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Just before the 80% mark: still the cached token, no refresh.
        vi.advanceTimersByTime(3600 * 0.8 * 1000 - 1000);
        const stillCached = await token.getToken();
        expect(stillCached).toEqual({ ok: true, value: 'token-1' });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Past the 80% mark: a fresh token is fetched.
        vi.advanceTimersByTime(2000);
        const refreshed = await token.getToken();
        expect(refreshed).toEqual({ ok: true, value: 'token-2' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('single-flights concurrent callers into one refresh request', async () => {
        let resolveFetch!: (response: Response) => void;
        const fetchMock = vi.fn().mockReturnValue(
            new Promise<Response>((resolve) => {
                resolveFetch = resolve;
            }),
        );
        const token = createBarentsWatchToken('client-id', 'client-secret', fetchMock);

        const first = token.getToken();
        const second = token.getToken();
        resolveFetch(jsonResponse({ access_token: 'token-1', expires_in: 3600 }));

        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toEqual({ ok: true, value: 'token-1' });
        expect(secondResult).toEqual({ ok: true, value: 'token-1' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns an error, never the client secret, on a non-OK response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
        const token = createBarentsWatchToken('client-id', 'the-real-secret', fetchMock);

        const result = await token.getToken();

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.message).not.toContain('the-real-secret');
            expect(JSON.stringify(result.error)).not.toContain('the-real-secret');
        }
    });

    it('invalidate() forces the next getToken() to refresh even while still fresh', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1', expires_in: 3600 }))
            .mockResolvedValueOnce(jsonResponse({ access_token: 'token-2', expires_in: 3600 }));
        const token = createBarentsWatchToken('client-id', 'client-secret', fetchMock);

        await token.getToken();
        token.invalidate();
        const result = await token.getToken();

        expect(result).toEqual({ ok: true, value: 'token-2' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
