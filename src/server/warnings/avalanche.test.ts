import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutboundGate } from '../outbound-gate.js';
import inSeasonFixture from './fixtures/nve-avalanche-warning-in-season.json' with { type: 'json' };
import outOfSeasonFixture from './fixtures/nve-avalanche-warning-out-of-season.json' with { type: 'json' };
import { avalancheWarningUrl, fetchRegionWarning, mapAvalancheWarning, normalizeValidAt, type RawWarningEntry } from './avalanche.js';

const REGION = {
    regionId: '3003',
    regionName: 'Vesterålen',
    outline: [
        [68.3, 14.2],
        [68.3, 15.6],
        [69.0, 15.6],
    ] as [number, number][],
};
const POINT = { lat: 68.5, lng: 14.8 };

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('avalancheWarningUrl', () => {
    it('builds the Detail URL with langKey 1 and the same date for from and to', () => {
        const url = avalancheWarningUrl('3003', '2026-01-15');

        expect(url).toBe('https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/AvalancheWarningByRegion/Detail/3003/1/2026-01-15/2026-01-15');
    });
});

describe('fetchRegionWarning', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the raw warning entries for a region', async () => {
        const result = await fetchRegionWarning('3003', '2026-01-15', {
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(inSeasonFixture)),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.RegionId).toBe(3003);
    });

    it('reports a network failure, a bad status and a non-JSON body as errors', async () => {
        const failed = await fetchRegionWarning('3003', '2026-01-15', {
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockRejectedValue(new Error('down')),
        });
        const badStatus = await fetchRegionWarning('3003', '2026-01-15', {
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
        });
        const notJson = await fetchRegionWarning('3003', '2026-01-15', {
            upstreamTimeoutMs: 1000,
            fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
        });

        expect(failed.ok).toBe(false);
        expect(badStatus.ok).toBe(false);
        expect(notJson.ok).toBe(false);
    });

    it('reports a shut gate as an ordinary error without calling upstream', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inSeasonFixture));
        const gate = createOutboundGate({ minIntervalMs: 600_000, burst: 1 });

        const first = await fetchRegionWarning('3003', '2026-01-15', { upstreamTimeoutMs: 1000, gate, fetchImpl: fetchMock });
        const second = await fetchRegionWarning('3003', '2026-01-15', { upstreamTimeoutMs: 1000, gate, fetchImpl: fetchMock });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('mapAvalancheWarning', () => {
    it('maps an in-season entry to an AvalancheWarning carrying the region outline and the given point', () => {
        const mapped = mapAvalancheWarning(inSeasonFixture, REGION, POINT);

        expect(mapped).not.toBeNull();
        expect(mapped?.regionId).toBe('3003');
        expect(mapped?.regionName).toBe('Vesterålen');
        expect(mapped?.dangerLevel).toBe(3);
        expect(mapped?.outline).toEqual(REGION.outline);
        expect(mapped?.point).toEqual(POINT);
    });

    it('returns null for the out-of-season case (DangerLevel "0" and MainText "Ikke vurdert")', () => {
        const mapped = mapAvalancheWarning(outOfSeasonFixture, REGION, POINT);

        expect(mapped).toBeNull();
    });

    it('returns null when DangerLevel alone is "0", even if MainText is not "Ikke vurdert"', () => {
        const entries: RawWarningEntry[] = [
            { RegionId: '3003', RegionName: 'Vesterålen', DangerLevel: '0', MainText: 'noe annet', ValidFrom: '2026-07-01T00:00:00' },
        ];

        expect(mapAvalancheWarning(entries, REGION, POINT)).toBeNull();
    });

    it('returns null when MainText alone is "Ikke vurdert", even if DangerLevel looks numeric', () => {
        const entries: RawWarningEntry[] = [
            { RegionId: '3003', RegionName: 'Vesterålen', DangerLevel: '1', MainText: 'Ikke vurdert', ValidFrom: '2026-07-01T00:00:00' },
        ];

        expect(mapAvalancheWarning(entries, REGION, POINT)).toBeNull();
    });

    it('returns null for an empty entry list -- no warning published for this date range', () => {
        expect(mapAvalancheWarning([], REGION, POINT)).toBeNull();
    });

    it('returns null for a DangerLevel outside the 1-5 scale', () => {
        const entries: RawWarningEntry[] = [{ RegionId: '3003', DangerLevel: '9', MainText: 'noe', ValidFrom: '2026-01-15T00:00:00' }];

        expect(mapAvalancheWarning(entries, REGION, POINT)).toBeNull();
    });

    it('treats a trailing space, a different case, or trailing punctuation on MainText as "not assessed" too', () => {
        const withSpace: RawWarningEntry[] = [{ RegionId: '3003', DangerLevel: '2', MainText: 'Ikke vurdert ', ValidFrom: '2026-01-15T00:00:00' }];
        const withCase: RawWarningEntry[] = [{ RegionId: '3003', DangerLevel: '2', MainText: 'IKKE VURDERT', ValidFrom: '2026-01-15T00:00:00' }];
        const withPunctuation: RawWarningEntry[] = [
            { RegionId: '3003', DangerLevel: '2', MainText: 'Ikke vurdert.', ValidFrom: '2026-01-15T00:00:00' },
        ];

        expect(mapAvalancheWarning(withSpace, REGION, POINT)).toBeNull();
        expect(mapAvalancheWarning(withCase, REGION, POINT)).toBeNull();
        expect(mapAvalancheWarning(withPunctuation, REGION, POINT)).toBeNull();
    });

    it("normalizes validAt (NVE's offset-less local time) to carry an explicit UTC offset", () => {
        const mapped = mapAvalancheWarning(inSeasonFixture, REGION, POINT);

        // Fixture's ValidFrom is "2026-01-15T00:00:00" -- January, so CET (+01:00).
        expect(mapped?.validAt).toBe('2026-01-15T00:00:00+01:00');
    });
});

describe('normalizeValidAt', () => {
    it('appends the winter (CET, +01:00) offset for a January date', () => {
        expect(normalizeValidAt('2026-01-15T00:00:00')).toBe('2026-01-15T00:00:00+01:00');
    });

    it('appends the summer (CEST, +02:00) offset for a July date', () => {
        expect(normalizeValidAt('2026-07-15T00:00:00')).toBe('2026-07-15T00:00:00+02:00');
    });

    it('leaves a timestamp that already carries an explicit offset unchanged', () => {
        expect(normalizeValidAt('2026-01-15T00:00:00Z')).toBe('2026-01-15T00:00:00Z');
        expect(normalizeValidAt('2026-01-15T00:00:00+02:00')).toBe('2026-01-15T00:00:00+02:00');
    });
});
