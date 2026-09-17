import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransitResponseSchema } from '../../shared/schemas/transit.js';
import vehiclesFixture from '../transit/fixtures/entur-vehicles-vesteralen.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

/** The Vesterålen viewport from `transit/fixtures/README.md`. */
const VALID_BBOX = 'bbox=14.5,68.35,16.5,69.05';

/**
 * Every fixture record's `lastUpdated` is fixed to 2026-09-15, so the age
 * filter this layer exists for needs a fixed clock to test at all --
 * unlike the roads fixture's open-ended situations, this data does not
 * stay fresh relative to the real clock. Set shortly after the freshest
 * record (`3390103000`, `17:24:50Z`) and well within the default 10
 * minute window, but more than 10 minutes past the stale one
 * (`3390090001`, `06:00:00Z`).
 */
const FIXTURE_NOW = new Date('2026-09-15T17:25:30Z');

describe('GET /api/transit', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('serves the mapped vehicles for a viewport', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FIXTURE_NOW);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = TransitResponseSchema.parse(response.json());
        expect(body.configured).toBe(true);
        if (!body.configured) return;

        const bus = body.vehicles.find((vehicle) => vehicle.id === '3390101274');
        expect(bus).toMatchObject({
            mode: 'bus',
            line: 'Sortland-Stm.nes-Melbu-Svolvær',
            publicCode: '754',
            operatorRef: 'NOR:Operator:185',
            origin: 'Melbu ferjekai',
            destination: 'Sortland bussterminal',
            delaySeconds: 201,
        });

        const ferry = body.vehicles.find((vehicle) => vehicle.id === '3390101999');
        expect(ferry?.mode).toBe('ferry');
        // A real-world empty string, not null: only an absent `operator`
        // object becomes null.
        expect(ferry?.operatorRef).toBe('');
        expect(ferry?.delaySeconds).toBe(-90);
        expect(ferry?.line).toBeNull();
        expect(ferry?.publicCode).toBeNull();

        const noOperatorAtAll = body.vehicles.find((vehicle) => vehicle.id === '3390103000');
        expect(noOperatorAtAll?.operatorRef).toBeNull();
        expect(noOperatorAtAll?.origin).toBeNull();

        // Dropped: not a bus or a ferry -- the mode filter, not a fault.
        expect(body.vehicles.map((vehicle) => vehicle.id)).not.toContain('3390102500');
        // Dropped: its own `lastUpdated` is well past the default max age.
        expect(body.vehicles.map((vehicle) => vehicle.id)).not.toContain('3390090001');

        expect(typeof body.fetchedAt).toBe('string');
    });

    it("asks Entur for the vehicles query, carrying this app's client name", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)['ET-Client-Name']).toBe('nesthus-area-overview-test');
    });

    it('responds 400 for an unparseable bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/transit?bbox=nope' });

        expect(response.statusCode).toBe(400);
    });

    it('responds 400 for a missing bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/transit' });

        expect(response.statusCode).toBe(400);
    });

    it('makes one upstream call for two requests inside the TTL', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ transitCacheTtlMs: 60_000 });

        await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });
        const second = await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });

        expect(second.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('serves a stale answer when Entur fails after a warm cache', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ transitCacheTtlMs: 10 });

        expect((await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` })).statusCode).toBe(200);
        await sleep(20);
        fetchMock.mockRejectedValue(new Error('Entur down'));

        const stale = await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
        expect(stale.headers['cache-control']).toBe('no-cache');
    });

    it('responds 502 on a cold cache when Entur is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Entur down')));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });

        expect(response.statusCode).toBe(502);
    });

    it('advertises freshness from its own TTL, never longer', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture)));
        const app = buildTestApp({ transitCacheTtlMs: 60_000 });

        const response = await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });

        expect(response.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60');
    });

    it('serves a stale answer rather than calling upstream when the Entur gate is shut', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture));
        vi.stubGlobal('fetch', fetchMock);
        // One token, refilled in ten minutes: the warm-up spends it.
        const app = buildTestApp({ transitCacheTtlMs: 10, enturMinIntervalMs: 600_000, enturBurst: 1 });

        expect((await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` })).statusCode).toBe(200);
        await sleep(20);

        const gated = await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });

        expect(gated.statusCode).toBe(200);
        expect(gated.headers['x-cache']).toBe('stale');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the bbox out of the log when the upstream fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Entur down')));
        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });
        await app.close();

        const output = written.join('');
        expect(output).toContain('transit');
        expect(output).not.toContain('14.500');
        expect(output).not.toContain('68.350');
    });

    it('says nothing at all when every record maps cleanly', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FIXTURE_NOW);
        // Only the good records this time -- the malformed/stale/filtered
        // cases live in the happy-path fixture and would otherwise trip
        // this assertion via the (expected) discard/filter warnings.
        const cleanFixture = {
            data: {
                vehicles: vehiclesFixture.data.vehicles.filter((vehicle) => vehicle.vehicleId !== '3390090001'),
            },
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(cleanFixture)));

        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        const response = await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });
        await app.close();

        expect(response.statusCode).toBe(200);
        expect(written.join('')).toBe('');
    });

    it('warns when the mapper discards records, naming the counts and no bbox', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FIXTURE_NOW);
        const broken = {
            data: {
                vehicles: [{ vehicleId: 'renamed-away' }, { vehicleId: 'renamed-away-too' }, ...vehiclesFixture.data.vehicles],
            },
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(broken)));

        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        const response = await app.inject({ method: 'GET', url: `/api/transit?${VALID_BBOX}` });
        await app.close();

        expect(response.statusCode).toBe(200);
        const output = written.join('');
        expect(output).toContain('transit vehicle records were discarded');
        expect(output).toContain('"attributes":2');
        // The one vehicle whose own fix is too old to show: a real
        // discard, distinct from the mode filter (which is silent).
        expect(output).toContain('"stale":1');
        expect(output).not.toContain('14.500');
        expect(output).not.toContain('68.350');
    });

    it('clamps an oversized bbox rather than rejecting it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/transit?bbox=-170,-80,170,80' });

        expect(response.statusCode).toBe(200);
    });
});
