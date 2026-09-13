import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoadSituationsResponseSchema } from '../../shared/schemas/roads.js';
import situationsFixture from '../roads/fixtures/situations-vesteralen.json' with { type: 'json' };
import { SITUATION_RECORD_LIMIT } from '../roads/vegvesen-wfs.js';
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

/** The Vesterålen viewport from the "Re-probing" commands in `roads/fixtures/README.md`. */
const VALID_BBOX = 'bbox=14.5,68.35,16.5,69.05';

/**
 * The two situations these tests assert on are the fixture's open-ended
 * ones (`END_TIME: null`, started in 2026): the route classifies against
 * the real clock, so anything with an end time would quietly expire out
 * of this suite one day. The status machinery itself is tested against a
 * fixed clock in `roads/situations.test.ts`.
 */
const GLAMVIKA_CLOSURE = 'NPRA_1003';

describe('GET /api/road-situations', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serves the mapped situations for a viewport', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(situationsFixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = RoadSituationsResponseSchema.parse(response.json());
        expect(body.configured).toBe(true);
        if (!body.configured) return;
        const closure = body.situations.find((situation) => situation.id === GLAMVIKA_CLOSURE);
        expect(closure?.closed).toBe(true);
        expect(closure?.status).toBe('current');
        // A closure's extent survives the whole HTTP path, simplified.
        expect(closure?.line).toHaveLength(2);
        expect(typeof body.fetchedAt).toBe('string');
    });

    it('asks the GeoServer for the situations layer, longitude-first', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(situationsFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(url.searchParams.get('typeNames')).toBe('datex_3_1:SituationSimple_v2');
        // Snapped outward to the 0.05-degree cache grid by `roundBbox`,
        // but still `minLng,minLat,maxLng,maxLat`.
        expect(url.searchParams.get('bbox')).toBe('14.5,68.35,16.5,69.05,EPSG:4326');
        expect(url.searchParams.get('count')).toBe('500');
    });

    it('responds 400 for an unparseable bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/road-situations?bbox=nope' });

        expect(response.statusCode).toBe(400);
    });

    it('responds 400 for a missing bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/road-situations' });

        expect(response.statusCode).toBe(400);
    });

    it('makes one upstream call for two requests inside the TTL', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(situationsFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ roadSituationsCacheTtlMs: 60_000 });

        await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });
        const second = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });

        expect(second.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('serves a stale answer when the GeoServer fails after a warm cache', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(situationsFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ roadSituationsCacheTtlMs: 10 });

        expect((await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` })).statusCode).toBe(200);
        await sleep(20);
        fetchMock.mockRejectedValue(new Error('GeoServer down'));

        const stale = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
        // A body the server has given up on must be revalidated before
        // it is shown again.
        expect(stale.headers['cache-control']).toBe('no-cache');
    });

    it('responds 502 on a cold cache when the GeoServer is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('GeoServer down')));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });

        expect(response.statusCode).toBe(502);
    });

    it('advertises freshness from its own TTL, never longer', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(situationsFixture)));
        const app = buildTestApp({ roadSituationsCacheTtlMs: 120_000 });

        const response = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });

        expect(response.headers['cache-control']).toBe('public, max-age=120, stale-while-revalidate=60');
    });

    it('serves a stale answer rather than calling upstream when the shared Vegvesen gate is shut', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(situationsFixture));
        vi.stubGlobal('fetch', fetchMock);
        // One token, refilled in ten minutes: the warm-up spends it.
        const app = buildTestApp({ roadSituationsCacheTtlMs: 10, vegvesenMinIntervalMs: 600_000, vegvesenBurst: 1 });

        expect((await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` })).statusCode).toBe(200);
        await sleep(20);

        const gated = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });

        expect(gated.statusCode).toBe(200);
        expect(gated.headers['x-cache']).toBe('stale');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('warns when the record cap truncates a viewport, without logging the bbox', async () => {
        // The one failure of this design nobody could see from the map: a
        // viewport dense enough to hit 500 records is served its freshest
        // 500 and told nothing. This log line is the only signal, so it
        // is asserted rather than assumed -- and asserted to carry no
        // coordinates, since the cache key here is a bbox.
        const template = situationsFixture.features[0];
        const capped = {
            type: 'FeatureCollection',
            features: Array.from({ length: SITUATION_RECORD_LIMIT }, (_unused, index) => ({
                ...template,
                properties: { ...template?.properties, SITUATION_ID: `NPRA_BULK_${String(index)}`, RECORD_ID: `NPRA_BULK_${String(index)}_1` },
            })),
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(capped)));

        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        const response = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });
        await app.close();

        expect(response.statusCode).toBe(200);
        const output = written.join('');
        expect(output).toContain('per-viewport record cap');
        expect(output).toContain('"records":500');
        expect(output).not.toContain('14.5');
        expect(output).not.toContain('68.35');
    });

    it('warns when the mapper discards records, naming the counts and no bbox', async () => {
        // The other invisible failure, and the one that has already
        // happened once on this branch: three attribute names were wrong.
        // A rename parses as nothing, empties the layer, and leaves the
        // masthead reading "0 vegmeldinger" -- exactly what a quiet
        // evening looks like. This warning is the only thing that tells
        // the two apart, so it is asserted, and asserted to carry
        // counts rather than coordinates.
        const broken = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: null, properties: { SITUASJON_ID: 'renamed-away' } },
                { type: 'Feature', geometry: null, properties: { SITUASJON_ID: 'renamed-away-too' } },
                ...situationsFixture.features,
            ],
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(broken)));

        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        const response = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });
        await app.close();

        expect(response.statusCode).toBe(200);
        const output = written.join('');
        expect(output).toContain('road situation records were discarded');
        expect(output).toContain('"dropped":2');
        expect(output).toContain(`"records":${String(situationsFixture.features.length + 2)}`);
        expect(output).toContain('"attributes":2');
        expect(output).not.toContain('14.5');
        expect(output).not.toContain('68.35');
    });

    it('says nothing at all when every record maps cleanly', async () => {
        // The other half of the promise: a warning that fires on an
        // ordinary response is one nobody reads. The fixture's expired
        // and far-future situations are dropped by design and must not
        // count as discards.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(situationsFixture)));

        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        const response = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });
        await app.close();

        expect(response.statusCode).toBe(200);
        expect(written.join('')).toBe('');
    });

    it('keeps the bbox out of the log when the upstream fails', async () => {
        // `serveCached` logs its cache key on failure, and this route's
        // key is the rounded viewport -- so the route passes a `logKey`
        // instead. Without it, an outage writes a stream of viewports
        // into the container log.
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('GeoServer down')));
        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });
        await app.close();

        const output = written.join('');
        expect(output).toContain('road-situations');
        expect(output).not.toContain('14.500');
        expect(output).not.toContain('68.350');
    });

    it('re-reads the clock on every response, so an outage cannot keep serving an ended situation as current', async () => {
        // The cache holds upstream's raw records, never the mapped
        // response, because `status` is derived from the clock and
        // `TtlCache` has no maximum stale age: an entry survives an
        // outage of any length. Freezing `status` into it would mean
        // serving "vegen er stengt" hours after the road reopened.
        //
        // Only `Date` is faked -- faking the timer queue as well would
        // stall Fastify's own injection machinery, and the clock is the
        // whole of what this test is about.
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-09-13T12:00:00+02:00'));
            const fetchMock = vi.fn().mockResolvedValue(jsonResponse(situationsFixture));
            vi.stubGlobal('fetch', fetchMock);
            const app = buildTestApp({ roadSituationsCacheTtlMs: 120_000 });

            const first = RoadSituationsResponseSchema.parse((await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` })).json());
            if (!first.configured) throw new Error('expected a configured response');
            // The accident runs until 14:00 today; the tunnel work starts
            // on the 20th.
            expect(first.situations.find((situation) => situation.id === 'NPRA_1009')?.status).toBe('current');
            expect(first.situations.find((situation) => situation.id === 'NPRA_1004')?.status).toBe('planned');

            // Eight days later, with the GeoServer down throughout: the
            // only thing this route can serve is that same cached entry.
            vi.setSystemTime(new Date('2026-09-21T12:00:00+02:00'));
            fetchMock.mockRejectedValue(new Error('GeoServer down'));

            const staleResponse = await app.inject({ method: 'GET', url: `/api/road-situations?${VALID_BBOX}` });
            expect(staleResponse.headers['x-cache']).toBe('stale');
            const stale = RoadSituationsResponseSchema.parse(staleResponse.json());
            if (!stale.configured) throw new Error('expected a configured response');

            // The accident ended a week ago: gone, not `current`.
            expect(stale.situations.map((situation) => situation.id)).not.toContain('NPRA_1009');
            // And the roadworks that had not started have started.
            expect(stale.situations.find((situation) => situation.id === 'NPRA_1004')?.status).toBe('current');
            // `fetchedAt` is not re-stamped: the data really is eight days
            // old, and the client shows that as an age.
            expect(stale.fetchedAt).toBe(first.fetchedAt);
            // Nothing left this process for it.
            expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clamps an oversized bbox rather than rejecting it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(situationsFixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/road-situations?bbox=-170,-80,170,80' });

        expect(response.statusCode).toBe(200);
    });
});
