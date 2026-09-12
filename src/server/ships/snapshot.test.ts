import { describe, expect, it, vi } from 'vitest';
import type { Result } from '../../shared/result.js';
import { ok } from '../../shared/result.js';
import type { Ship } from '../../shared/schemas/ships.js';
import combinedFixture from './fixtures/combined-synthetic.json' with { type: 'json' };
import { createShipsSnapshot } from './snapshot.js';
import type { BarentsWatchToken } from './token.js';

const REFRESH_MS = 10_000;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A token that always succeeds without a network call -- the snapshot's own behaviour is what is under test, not the OAuth dance. */
function fakeToken(): BarentsWatchToken {
    return { getToken: () => Promise.resolve(ok('a-token')), invalidate: () => undefined };
}

function shipsOf(result: Result<readonly Ship[]>): readonly Ship[] {
    if (!result.ok) throw new Error(`expected ships, got error: ${result.error.message}`);
    return result.value;
}

describe('createShipsSnapshot', () => {
    it('single-flights concurrent callers into one upstream fetch', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(combinedFixture));
        const snapshot = createShipsSnapshot(fakeToken(), { upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const [first, second, third] = await Promise.all([snapshot.ships(0), snapshot.ships(0), snapshot.ships(0)]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(shipsOf(first).length).toBeGreaterThan(0);
        expect(shipsOf(second)).toEqual(shipsOf(first));
        expect(shipsOf(third)).toEqual(shipsOf(first));
    });

    it('serves the held snapshot without refetching inside the refresh window', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(combinedFixture));
        const snapshot = createShipsSnapshot(fakeToken(), { upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const first = await snapshot.ships(0);
        const second = await snapshot.ships(REFRESH_MS - 1);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(shipsOf(second)).toEqual(shipsOf(first));
    });

    it('refetches once the refresh window has elapsed', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(combinedFixture));
        const snapshot = createShipsSnapshot(fakeToken(), { upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        await snapshot.ships(0);
        await snapshot.ships(REFRESH_MS);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps serving the previous snapshot when a refresh fails', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(combinedFixture)).mockRejectedValueOnce(new Error('upstream is down'));
        const snapshot = createShipsSnapshot(fakeToken(), { upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const fresh = await snapshot.ships(0);
        const afterFailure = await snapshot.ships(REFRESH_MS);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(afterFailure.ok).toBe(true);
        expect(shipsOf(afterFailure)).toEqual(shipsOf(fresh));
    });

    it('returns the error when a refresh fails and there is no previous snapshot', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('upstream is down'));
        const snapshot = createShipsSnapshot(fakeToken(), { upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const result = await snapshot.ships(0);

        expect(result.ok).toBe(false);
    });

    it('gates on the last attempt, so a failing upstream is not retried by every caller in the window', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('upstream is down'));
        const snapshot = createShipsSnapshot(fakeToken(), { upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const first = await snapshot.ships(0);
        const second = await snapshot.ships(REFRESH_MS - 1);

        // One attempt, and the second caller still learns it failed rather
        // than being handed a silent empty list.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(first.ok).toBe(false);
        expect(second.ok).toBe(false);
    });

    it('retries a failing upstream once the window has elapsed, and recovers', async () => {
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error('upstream is down')).mockResolvedValueOnce(jsonResponse(combinedFixture));
        const snapshot = createShipsSnapshot(fakeToken(), { upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const failed = await snapshot.ships(0);
        const recovered = await snapshot.ships(REFRESH_MS);

        expect(failed.ok).toBe(false);
        expect(shipsOf(recovered).length).toBeGreaterThan(0);
    });

    it('stops serving a held snapshot once it is older than maxStaleMs, so the caller can fall back to something honest', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(combinedFixture)).mockRejectedValue(new Error('upstream is down'));
        const snapshot = createShipsSnapshot(fakeToken(), {
            upstreamTimeoutMs: 5000,
            refreshMs: REFRESH_MS,
            maxStaleMs: 60_000,
            fetchImpl: fetchMock,
        });

        await snapshot.ships(0);

        // Still young enough to pass for current traffic...
        const stillFresh = await snapshot.ships(REFRESH_MS);
        expect(stillFresh.ok).toBe(true);

        // ...but hours-old positions must not be dressed up as live ones.
        const tooOld = await snapshot.ships(60_001 + REFRESH_MS);
        expect(tooOld.ok).toBe(false);
    });

    it('holds the whole country, not one viewport -- nothing is filtered on the way in', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(combinedFixture));
        const snapshot = createShipsSnapshot(fakeToken(), { upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const ships = shipsOf(await snapshot.ships(0));

        // The fixture's six entries include "UKJENT LOSBAT", which carries
        // no position and so cannot be placed on a map at all. Every other
        // one survives -- including "OUTSIDE VIEW" up at 71N/25E, far from
        // any viewport the kiosk looks at. The route's `shipsWithin` is the
        // only thing that ever narrows this.
        expect(ships).toHaveLength(5);
        expect(ships.map((ship) => ship.name)).toContain('OUTSIDE VIEW');
    });
});
