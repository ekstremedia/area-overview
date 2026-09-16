import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarningsResponseSchema } from '../../shared/schemas/warnings.js';
import alertsFixture from '../warnings/fixtures/met-alerts-northern-norway.json' with { type: 'json' };
import inSeasonFixture from '../warnings/fixtures/nve-avalanche-warning-in-season.json' with { type: 'json' };
import outOfSeasonFixture from '../warnings/fixtures/nve-avalanche-warning-out-of-season.json' with { type: 'json' };
import regionsFixture from '../warnings/fixtures/nve-regions-northern-norway.json' with { type: 'json' };
import { MET_ALERTS_URL } from '../warnings/met-alerts.js';
import { NVE_REGIONS_URL } from '../warnings/regions.js';
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

/** The Vesterålen/Ofoten viewport from `warnings/fixtures/README.md` -- touches regions 3003 and 3004. */
const VALID_BBOX = 'bbox=14.5,68.35,16.5,69.05';
/** Nowhere near any fixture region (Bergen-ish). */
const NO_REGION_BBOX = 'bbox=5.0,60.0,5.5,60.3';

type Outcome = 'ok' | 'fail';

interface MockOptions {
    met?: Outcome;
    regions?: Outcome;
    regionWarnings?: Record<string, Outcome>;
}

/**
 * One `fetch` stub standing in for both upstreams at once, dispatching on
 * the URL -- this route calls MET Alerts, NVE's region roster and (for
 * every intersecting region) NVE's per-region warning endpoint, all
 * through the same global `fetch`, the same way every other route test in
 * this codebase stubs one global `fetch` rather than per-call injection.
 */
function buildFetchMock(options: MockOptions = {}) {
    return vi.fn((input: unknown): Promise<Response> => {
        const url = String(input);
        if (url === MET_ALERTS_URL) {
            if (options.met === 'fail') return Promise.reject(new Error('MET Alerts down'));
            return Promise.resolve(jsonResponse(alertsFixture));
        }
        if (url === NVE_REGIONS_URL) {
            if (options.regions === 'fail') return Promise.reject(new Error('NVE Region down'));
            return Promise.resolve(jsonResponse(regionsFixture));
        }
        if (url.includes('/Detail/3003/')) {
            if (options.regionWarnings?.['3003'] === 'fail') return Promise.reject(new Error('NVE warning down (3003)'));
            return Promise.resolve(jsonResponse(inSeasonFixture));
        }
        if (url.includes('/Detail/3004/')) {
            if (options.regionWarnings?.['3004'] === 'fail') return Promise.reject(new Error('NVE warning down (3004)'));
            return Promise.resolve(jsonResponse(outOfSeasonFixture));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
    });
}

/** How many calls this mock made to one of the three upstream endpoints. */
function callsTo(fetchMock: ReturnType<typeof buildFetchMock>, matcher: (url: string) => boolean): number {
    return fetchMock.mock.calls.filter((call) => matcher(String(call[0]))).length;
}

describe('GET /api/warnings', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serves the mapped weather and avalanche warnings for a viewport touching two regions', async () => {
        vi.stubGlobal('fetch', buildFetchMock());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = WarningsResponseSchema.parse(response.json());
        expect(body.configured).toBe(true);
        if (!body.configured) return;

        expect(body.weatherWarnings).not.toBeNull();
        const ids = body.weatherWarnings?.map((warning) => warning.id) ?? [];
        expect(ids).toContain('2.49.0.1.578.0.1');
        expect(ids).not.toContain('2.49.0.1.578.0.4'); // Oslo, outside the bbox

        expect(body.avalancheWarnings).not.toBeNull();
        // Region 3003 is in season (DangerLevel "3"); 3004 is out of season
        // ("Ikke vurdert") and so produces no entry at all.
        expect(body.avalancheWarnings).toHaveLength(1);
        expect(body.avalancheWarnings?.[0]).toMatchObject({ regionId: '3003', regionName: 'Vesterålen', dangerLevel: 3 });
        expect(body.avalancheWarnings?.[0]?.outline.length).toBeGreaterThanOrEqual(3);

        expect(typeof body.fetchedAt).toBe('string');
    });

    it('returns an empty avalancheWarnings array, not an error, for a bbox touching no region', async () => {
        vi.stubGlobal('fetch', buildFetchMock());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/warnings?${NO_REGION_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = WarningsResponseSchema.parse(response.json());
        if (!body.configured) throw new Error('expected configured:true');
        expect(body.avalancheWarnings).toEqual([]);
    });

    it('responds 400 for an unparseable bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/warnings?bbox=nope' });

        expect(response.statusCode).toBe(400);
    });

    it('responds 400 for a missing bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/warnings' });

        expect(response.statusCode).toBe(400);
    });

    it('makes one upstream call per provider for two requests inside the TTL', async () => {
        const fetchMock = buildFetchMock();
        vi.stubGlobal('fetch', fetchMock);
        // A generous NVE burst here: this test is about the TTL cache, not
        // the gate (whose default burst of 2 would otherwise be exhausted
        // by the roster fetch plus one region, silently gate-skipping the
        // second region's fetch and confounding the assertions below).
        const app = buildTestApp({
            metAlertsCacheTtlMs: 60_000,
            avalancheCacheTtlMs: 60_000,
            avalancheRegionsCacheTtlMs: 60_000,
            nveBurst: 10,
        });

        await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });
        const second = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(second.statusCode).toBe(200);
        expect(callsTo(fetchMock, (url) => url === MET_ALERTS_URL)).toBe(1);
        expect(callsTo(fetchMock, (url) => url === NVE_REGIONS_URL)).toBe(1);
        expect(callsTo(fetchMock, (url) => url.includes('/Detail/3003/'))).toBe(1);
        expect(callsTo(fetchMock, (url) => url.includes('/Detail/3004/'))).toBe(1);
    });

    it('serves a stale weather answer when MET fails after a warm cache, while avalanche warnings stay fresh', async () => {
        const fetchMock = buildFetchMock();
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ metAlertsCacheTtlMs: 10, avalancheCacheTtlMs: 60_000, avalancheRegionsCacheTtlMs: 60_000 });

        const first = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });
        expect(first.statusCode).toBe(200);
        const firstBody = WarningsResponseSchema.parse(first.json());
        if (!firstBody.configured) throw new Error('expected configured:true');

        await sleep(20);
        fetchMock.mockImplementation((input: unknown) => {
            const url = String(input);
            if (url === MET_ALERTS_URL) return Promise.reject(new Error('MET Alerts down'));
            return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });

        const stale = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
        const staleBody = WarningsResponseSchema.parse(stale.json());
        if (!staleBody.configured) throw new Error('expected configured:true');
        // The stale MET answer is the same data served a moment ago, not null.
        expect(staleBody.weatherWarnings).toEqual(firstBody.weatherWarnings);
        // Avalanche half untouched by the MET failure: still fresh data,
        // fetched from cache within its own (much longer) TTL, no upstream
        // call for it on this second request.
        expect(staleBody.avalancheWarnings).toEqual(firstBody.avalancheWarnings);
    });

    it("serves a stale avalanche answer when NVE's region roster fails after a warm cache, while weather warnings stay fresh", async () => {
        const fetchMock = buildFetchMock();
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ metAlertsCacheTtlMs: 60_000, avalancheCacheTtlMs: 60_000, avalancheRegionsCacheTtlMs: 10 });

        const first = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });
        expect(first.statusCode).toBe(200);
        const firstBody = WarningsResponseSchema.parse(first.json());
        if (!firstBody.configured) throw new Error('expected configured:true');

        await sleep(20);
        fetchMock.mockImplementation((input: unknown) => {
            const url = String(input);
            if (url === NVE_REGIONS_URL) return Promise.reject(new Error('NVE Region down'));
            return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });

        const stale = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
        const staleBody = WarningsResponseSchema.parse(stale.json());
        if (!staleBody.configured) throw new Error('expected configured:true');
        expect(staleBody.avalancheWarnings).toEqual(firstBody.avalancheWarnings);
        expect(staleBody.weatherWarnings).toEqual(firstBody.weatherWarnings);
    });

    it('serves fresh weather warnings with avalancheWarnings:null when the NVE region roster fails on a cold cache (independence, not a 502)', async () => {
        vi.stubGlobal('fetch', buildFetchMock({ regions: 'fail' }));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = WarningsResponseSchema.parse(response.json());
        if (!body.configured) throw new Error('expected configured:true');
        expect(body.avalancheWarnings).toBeNull();
        expect(body.weatherWarnings).not.toBeNull();
        expect(body.weatherWarnings?.length).toBeGreaterThan(0);
    });

    it('serves fresh avalanche warnings with weatherWarnings:null when MET fails on a cold cache (independence, not a 502)', async () => {
        vi.stubGlobal('fetch', buildFetchMock({ met: 'fail' }));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = WarningsResponseSchema.parse(response.json());
        if (!body.configured) throw new Error('expected configured:true');
        expect(body.weatherWarnings).toBeNull();
        expect(body.avalancheWarnings).not.toBeNull();
        expect(body.avalancheWarnings).toHaveLength(1);
    });

    it('reports avalancheWarnings:null (not []) when the roster is fine but every intersecting region fetch fails cold', async () => {
        vi.stubGlobal('fetch', buildFetchMock({ regionWarnings: { 3003: 'fail', 3004: 'fail' } }));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = WarningsResponseSchema.parse(response.json());
        if (!body.configured) throw new Error('expected configured:true');
        // Roster fine, >=1 intersecting region (3003, 3004), every
        // per-region fetch fails with nothing stale cached yet -- this is
        // "we don't know", not "no avalanche danger anywhere".
        expect(body.avalancheWarnings).toBeNull();
        expect(body.weatherWarnings).not.toBeNull();
    });

    it('responds 502 on a cold cache only when both MET and NVE are unreachable', async () => {
        vi.stubGlobal('fetch', buildFetchMock({ met: 'fail', regions: 'fail' }));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(response.statusCode).toBe(502);
    });

    it('keeps the bbox out of the log on a total failure', async () => {
        vi.stubGlobal('fetch', buildFetchMock({ met: 'fail', regions: 'fail' }));
        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });
        await app.close();

        const output = written.join('');
        expect(output).not.toContain('14.5');
        expect(output).not.toContain('68.35');
        expect(output).not.toContain('16.5');
        expect(output).not.toContain('69.05');
    });

    it('keeps the bbox out of the log on a partial (single-region) failure', async () => {
        vi.stubGlobal('fetch', buildFetchMock({ regionWarnings: { 3003: 'fail' } }));
        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        const response = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });
        await app.close();

        expect(response.statusCode).toBe(200);
        const output = written.join('');
        expect(output).toContain('3003');
        expect(output).not.toContain('14.5');
        expect(output).not.toContain('68.35');
    });

    it('clamps an oversized bbox rather than rejecting it', async () => {
        vi.stubGlobal('fetch', buildFetchMock());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/warnings?bbox=-170,-80,170,80' });

        expect(response.statusCode).toBe(200);
    });

    it('advertises freshness from the shorter of the two halves TTLs', async () => {
        vi.stubGlobal('fetch', buildFetchMock());
        const app = buildTestApp({ metAlertsCacheTtlMs: 5_000, avalancheCacheTtlMs: 60_000, avalancheRegionsCacheTtlMs: 60_000 });

        const response = await app.inject({ method: 'GET', url: `/api/warnings?${VALID_BBOX}` });

        expect(response.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=60');
    });
});
