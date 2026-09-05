/**
 * Caches the BarentsWatch OAuth2 client-credentials access token in
 * memory, refreshing at ~80% of the token's own `expires_in` (documented
 * as 3600s -- refresh happens after ~48 minutes) and single-flighting
 * concurrent callers into one refresh request.
 *
 * Hand-rolled rather than built on `TtlCache<string>`: `TtlCache`'s TTL
 * is fixed at construction, but this cache's TTL is derived from each
 * response's own `expires_in`, which is worth respecting even though the
 * BarentsWatch docs say it's always 3600 -- a future response with a
 * different value should still be honoured correctly rather than
 * silently ignored by a hardcoded `TtlCache` TTL.
 *
 * The client secret and the bearer token itself never appear in a log
 * line or a thrown/returned error message -- every failure path below
 * returns a message describing *what* failed (status code, schema
 * validation, network error), never the request body or the response
 * body that could contain either.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';

const TOKEN_URL = 'https://id.barentswatch.no/connect/token';

/** Refresh once 80% of the token's lifetime has elapsed, not at the last moment -- leaves margin for a request already in flight when the token turns stale. */
const REFRESH_FRACTION = 0.8;

const TokenResponseSchema = z.object({
    access_token: z.string(),
    expires_in: z.number().positive(),
});

export interface BarentsWatchToken {
    /** Returns a currently-valid access token, refreshing (and single-flighting concurrent callers) if none is cached or the cached one is past its refresh point. */
    getToken(): Promise<Result<string>>;
    /** Forces the next `getToken()` call to fetch a fresh token, regardless of cache state -- used after a `401` from the data API to rule out a stale/revoked token before giving up. */
    invalidate(): void;
}

export function createBarentsWatchToken(
    clientId: string,
    clientSecret: string,
    upstreamTimeoutMs: number,
    fetchImpl: typeof fetch = fetch,
): BarentsWatchToken {
    let cached: { token: string; refreshAt: number } | undefined;
    let inflight: Promise<Result<string>> | undefined;

    async function refresh(): Promise<Result<string>> {
        let response: Response;
        try {
            response = await fetchImpl(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    scope: 'ais',
                    grant_type: 'client_credentials',
                }).toString(),
                signal: AbortSignal.timeout(upstreamTimeoutMs),
            });
        } catch {
            return err({ message: 'BarentsWatch token request failed (network error)' });
        }

        if (!response.ok) {
            return err({ message: `BarentsWatch token endpoint responded with status ${String(response.status)}` });
        }

        let body: unknown;
        try {
            body = await response.json();
        } catch {
            return err({ message: 'BarentsWatch token endpoint returned a non-JSON body' });
        }

        const parsed = TokenResponseSchema.safeParse(body);
        if (!parsed.success) {
            return err({ message: 'BarentsWatch token endpoint response failed schema validation' });
        }

        cached = {
            token: parsed.data.access_token,
            refreshAt: Date.now() + parsed.data.expires_in * REFRESH_FRACTION * 1000,
        };
        return ok(cached.token);
    }

    async function getToken(): Promise<Result<string>> {
        if (cached && Date.now() < cached.refreshAt) {
            return ok(cached.token);
        }

        if (inflight) {
            return inflight;
        }

        const load = refresh().finally(() => {
            inflight = undefined;
        });
        inflight = load;
        return load;
    }

    function invalidate(): void {
        cached = undefined;
    }

    return { getToken, invalidate };
}
