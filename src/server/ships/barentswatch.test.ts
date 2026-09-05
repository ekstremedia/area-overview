import { describe, expect, it, vi } from 'vitest';
import combinedFixture from './fixtures/combined-synthetic.json' with { type: 'json' };
import { fetchShips, mapRawShipsToShips } from './barentswatch.js';
import type { BarentsWatchToken } from './token.js';
import type { Bbox } from '../layers/bbox.js';

const testBbox: Bbox = { minLat: 68.5, minLng: 15.0, maxLat: 69.0, maxLng: 16.0 };

function fakeToken(overrides: Partial<BarentsWatchToken> = {}): BarentsWatchToken {
    return {
        getToken: vi.fn().mockResolvedValue({ ok: true, value: 'a-bearer-token' }),
        invalidate: vi.fn(),
        ...overrides,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('mapRawShipsToShips (fixture-based, no network)', () => {
    const ships = mapRawShipsToShips(combinedFixture, testBbox);

    it('maps mmsi to a string', () => {
        const nordlys = ships.find((s) => s.name === 'MS NORDLYS');
        expect(nordlys?.mmsi).toBe('257123456');
        expect(typeof nordlys?.mmsi).toBe('string');
    });

    it('maps trueHeading 511 ("not available") to null', () => {
        const fiskebat = ships.find((s) => s.name === 'FISKEBAT SENIOR');
        expect(fiskebat?.heading).toBeNull();
    });

    it('drops ships with null lat/lng entirely', () => {
        expect(ships.some((s) => s.name === 'UKJENT LOSBAT')).toBe(false);
    });

    it('defaults null speedOverGround/courseOverGround to 0', () => {
        const coastal = ships.find((s) => s.name === 'COASTAL EXPRESS');
        expect(coastal?.speedOverGround).toBe(0);
        expect(coastal?.courseOverGround).toBe(0);
    });

    it('filters out ships outside the requested bbox', () => {
        expect(ships.some((s) => s.name === 'OUTSIDE VIEW')).toBe(false);
    });

    it('maps shipType to a string', () => {
        const nordlys = ships.find((s) => s.name === 'MS NORDLYS');
        expect(nordlys?.shipType).toBe('60');
    });

    it('carries msgtime through as the timestamp', () => {
        const nordlys = ships.find((s) => s.name === 'MS NORDLYS');
        expect(nordlys?.timestamp).toBe('2026-09-05T10:00:00Z');
    });
});

describe('fetchShips', () => {
    it('fetches with a bearer token and returns mapped, bbox-filtered ships', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(combinedFixture));
        const token = fakeToken();

        const result = await fetchShips(testBbox, token, 5000, fetchMock);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.map((s) => s.name).sort()).toEqual(['COASTAL EXPRESS', 'FISKEBAT SENIOR', 'MS NORDLYS']);
        }
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://live.ais.barentswatch.no/v1/latest/combined');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer a-bearer-token');
    });

    it('on a 401, invalidates the token and retries exactly once', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
            .mockResolvedValueOnce(jsonResponse(combinedFixture));
        const getToken = vi.fn().mockResolvedValueOnce({ ok: true, value: 'stale-token' }).mockResolvedValueOnce({ ok: true, value: 'fresh-token' });
        const invalidate = vi.fn();
        const token: BarentsWatchToken = { getToken, invalidate };

        const result = await fetchShips(testBbox, token, 5000, fetchMock);

        expect(result.ok).toBe(true);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(getToken).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not loop forever if the retry also 401s', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
        const token = fakeToken();

        const result = await fetchShips(testBbox, token, 5000, fetchMock);

        expect(result.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2); // one initial attempt, one retry, never a third
    });

    it('returns an error when the token itself cannot be obtained', async () => {
        const fetchMock = vi.fn();
        const token = fakeToken({ getToken: vi.fn().mockResolvedValue({ ok: false, error: { message: 'token unavailable' } }) });

        const result = await fetchShips(testBbox, token, 5000, fetchMock);

        expect(result.ok).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never lets the bearer token or a client secret appear in a returned error message', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
        const token = fakeToken({ getToken: vi.fn().mockResolvedValue({ ok: true, value: 'top-secret-bearer-token' }) });

        const result = await fetchShips(testBbox, token, 5000, fetchMock);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(JSON.stringify(result.error)).not.toContain('top-secret-bearer-token');
        }
    });

    it('resolves to err(...) rather than hanging when the combined-AIS request never settles', async () => {
        const fetchMock = vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted', 'TimeoutError'));
                });
            });
        });
        const token = fakeToken();

        const result = await fetchShips(testBbox, token, 1, fetchMock);

        expect(result.ok).toBe(false);
    });
});
