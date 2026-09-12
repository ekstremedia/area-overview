import { describe, expect, it, vi } from 'vitest';
import ovationFixture from './fixtures/ovation-sample.json' with { type: 'json' };
import { buildOvationGrid, createOvationClient } from './ovation.js';

const REFRESH_MS = 5 * 60_000;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function requireGrid(grid: ReturnType<typeof buildOvationGrid>): NonNullable<ReturnType<typeof buildOvationGrid>> {
    if (!grid) throw new Error('expected a grid');
    return grid;
}

describe('buildOvationGrid', () => {
    it('reads the two values checked against the live endpoint at capture time', () => {
        // If NOAA changes the grid resolution or the coordinate ordering,
        // these are the assertions that notice. See the fixtures README.
        const grid = requireGrid(buildOvationGrid(ovationFixture));

        expect(grid.probabilityAt(68.6984, 15.4129)).toBe(9);
        expect(grid.probabilityAt(59.91, 10.75)).toBe(0);
    });

    it('normalises longitude, so a western coordinate and its 0..359 twin agree', () => {
        // NOAA publishes longitude as 0..359; the app hands it -180..180.
        const grid = requireGrid(buildOvationGrid(ovationFixture));

        expect(grid.probabilityAt(69, -10)).toBe(grid.probabilityAt(69, 350));
    });

    it('carries the observation and forecast times through', () => {
        const grid = requireGrid(buildOvationGrid(ovationFixture));

        expect(grid.observationTime).toBe(ovationFixture['Observation Time']);
        expect(grid.forecastTime).toBe(ovationFixture['Forecast Time']);
    });

    it('answers zero for a cell the grid does not cover, rather than throwing', () => {
        // The fixture is a band around Norway; the southern hemisphere is
        // simply absent from it.
        const grid = requireGrid(buildOvationGrid(ovationFixture));

        expect(grid.probabilityAt(-45, 170)).toBe(0);
    });

    it('returns null for a payload that is not an OVATION response', () => {
        expect(buildOvationGrid({ nope: true })).toBeNull();
        expect(buildOvationGrid(null)).toBeNull();
        expect(buildOvationGrid({ coordinates: [[1, 2]] })).toBeNull();
    });
});

describe('createOvationClient', () => {
    it('fetches once and serves the same grid inside the refresh window', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(ovationFixture)));
        const client = createOvationClient({ upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const first = await client.gridFor(0);
        const second = await client.gridFor(REFRESH_MS - 1);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
    });

    it('single-flights concurrent callers', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(ovationFixture)));
        const client = createOvationClient({ upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        await Promise.all([client.gridFor(0), client.gridFor(0), client.gridFor(0)]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refetches once the window has elapsed', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(ovationFixture)));
        const client = createOvationClient({ upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        await client.gridFor(0);
        await client.gridFor(REFRESH_MS);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the previous grid when a refresh fails', async () => {
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(ovationFixture)))
            .mockImplementation(() => Promise.reject(new Error('NOAA is down')));
        const client = createOvationClient({ upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const fresh = await client.gridFor(0);
        const afterFailure = await client.gridFor(REFRESH_MS);

        expect(afterFailure).toBe(fresh);
    });

    it('keeps the previous grid when a refresh returns nonsense', async () => {
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(ovationFixture)))
            .mockImplementation(() => Promise.resolve(jsonResponse({ nope: true })));
        const client = createOvationClient({ upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        const fresh = await client.gridFor(0);

        expect(await client.gridFor(REFRESH_MS)).toBe(fresh);
    });

    it('is null when NOAA has never answered', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.reject(new Error('NOAA is down')));
        const client = createOvationClient({ upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        expect(await client.gridFor(0)).toBeNull();
    });

    it('gates on the last attempt, so a failing NOAA is not retried by every request', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.reject(new Error('NOAA is down')));
        const client = createOvationClient({ upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        await client.gridFor(0);
        await client.gridFor(REFRESH_MS - 1);
        await client.gridFor(REFRESH_MS - 1);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('treats a non-200 as a failed refresh rather than parsing the error page', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ error: 'nope' }, 503)));
        const client = createOvationClient({ upstreamTimeoutMs: 5000, refreshMs: REFRESH_MS, fetchImpl: fetchMock });

        expect(await client.gridFor(0)).toBeNull();
    });
});
