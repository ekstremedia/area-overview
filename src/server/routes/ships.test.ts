import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShipsResponseSchema } from '../../shared/schemas/ships.js';
import combinedFixture from '../ships/fixtures/combined-synthetic.json' with { type: 'json' };
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

const VALID_BBOX = 'bbox=15.0,68.5,16.0,69.0';

describe('GET /api/ships -- unconfigured (no BarentsWatch credentials)', () => {
    it('responds 503 {configured:false} with no BARENTSWATCH_CLIENT_ID/SECRET set, needing zero real credentials', async () => {
        const app = buildTestApp({ barentswatchClientId: '', barentswatchClientSecret: '' });

        const response = await app.inject({ method: 'GET', url: `/api/ships?${VALID_BBOX}` });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ configured: false });
    });

    it('still validates the bbox before checking configuration', async () => {
        const app = buildTestApp({ barentswatchClientId: '', barentswatchClientSecret: '' });

        const response = await app.inject({ method: 'GET', url: '/api/ships?bbox=not-a-bbox' });

        expect(response.statusCode).toBe(400);
    });

    it('responds 400 for a missing bbox', async () => {
        const app = buildTestApp({ barentswatchClientId: '', barentswatchClientSecret: '' });

        const response = await app.inject({ method: 'GET', url: '/api/ships' });

        expect(response.statusCode).toBe(400);
    });
});

describe('GET /api/ships -- configured', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns {configured:true, ships, fetchedAt} on success', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'a-token', expires_in: 3600 }))
            .mockResolvedValueOnce(jsonResponse(combinedFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ barentswatchClientId: 'client-id', barentswatchClientSecret: 'client-secret' });

        const response = await app.inject({ method: 'GET', url: `/api/ships?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = ShipsResponseSchema.parse(response.json());
        expect(body.configured).toBe(true);
        if (body.configured) {
            expect(body.ships.length).toBeGreaterThan(0);
            expect(typeof body.fetchedAt).toBe('string');
        }
    });

    it('clamps an oversized bbox rather than rejecting it with 400', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'a-token', expires_in: 3600 }))
            .mockResolvedValueOnce(jsonResponse(combinedFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ barentswatchClientId: 'client-id', barentswatchClientSecret: 'client-secret' });

        const response = await app.inject({ method: 'GET', url: '/api/ships?bbox=-170,-80,170,80' });

        expect(response.statusCode).toBe(200);
    });

    it('serves stale ships (never a blank map) on an upstream hiccup after a warm cache', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'a-token', expires_in: 3600 }))
            .mockResolvedValueOnce(jsonResponse(combinedFixture));
        vi.stubGlobal('fetch', fetchMock);
        // `shipsSnapshotMaxStaleMs: 0` stops the shared nationwide snapshot
        // from answering through the outage, which is what puts this
        // viewport's own stale cache back in the path. Without it the
        // request succeeds for a different (also correct) reason -- see the
        // snapshot-serves-every-viewport test below -- and this one would
        // pass without ever exercising `X-Cache: stale`.
        const app = buildTestApp({
            barentswatchClientId: 'client-id',
            barentswatchClientSecret: 'client-secret',
            shipsCacheTtlMs: 10,
            shipsSnapshotRefreshMs: 10,
            shipsSnapshotMaxStaleMs: 0,
        });

        const warm = await app.inject({ method: 'GET', url: `/api/ships?${VALID_BBOX}` });
        expect(warm.statusCode).toBe(200);

        await sleep(20);
        fetchMock.mockRejectedValue(new Error('network down'));

        const stale = await app.inject({ method: 'GET', url: `/api/ships?${VALID_BBOX}` });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
    });

    it('serves every viewport from one nationwide fetch, however many viewports there are', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'a-token', expires_in: 3600 }))
            .mockResolvedValue(jsonResponse(combinedFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ barentswatchClientId: 'client-id', barentswatchClientSecret: 'client-secret' });

        // Three different places, the way three visitors would ask.
        const bboxes = ['15.0,68.5,16.0,69.0', '10.0,59.5,11.0,60.5', '5.0,60.0,6.0,61.0'];
        const responses = await Promise.all(bboxes.map((bbox) => app.inject({ method: 'GET', url: `/api/ships?bbox=${bbox}` })));

        for (const response of responses) {
            expect(response.statusCode).toBe(200);
        }

        // One token request plus exactly one nationwide AIS download --
        // this is the whole point of the snapshot. Before it, this was
        // three full-country fetches.
        const aisCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('live.ais.barentswatch.no'));
        expect(aisCalls).toHaveLength(1);
    });

    it('gives each viewport only its own ships, not the whole country', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'a-token', expires_in: 3600 }))
            .mockResolvedValue(jsonResponse(combinedFixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ barentswatchClientId: 'client-id', barentswatchClientSecret: 'client-secret' });

        const inArea = await app.inject({ method: 'GET', url: `/api/ships?${VALID_BBOX}` });
        const elsewhere = await app.inject({ method: 'GET', url: '/api/ships?bbox=-60.0,-40.0,-59.0,-39.0' });
        // Same latitudes as the fixture's ships (68.68-68.75), shifted a
        // degree east of them. Nothing may come back: without this, the
        // test would pass on a filter that ignored longitude entirely,
        // since the only fixture ship outside `VALID_BBOX` is outside it in
        // both dimensions at once.
        const sameLatitudeEastward = await app.inject({ method: 'GET', url: '/api/ships?bbox=16.5,68.5,17.5,69.0' });

        const here = ShipsResponseSchema.parse(inArea.json());
        const there = ShipsResponseSchema.parse(elsewhere.json());
        const eastward = ShipsResponseSchema.parse(sameLatitudeEastward.json());
        if (!here.configured || !there.configured || !eastward.configured) throw new Error('expected configured responses');

        expect(here.ships.length).toBeGreaterThan(0);
        expect(there.ships).toHaveLength(0);
        expect(eastward.ships).toHaveLength(0);
        for (const ship of here.ships) {
            expect(ship.lat).toBeGreaterThanOrEqual(68.5);
            expect(ship.lat).toBeLessThanOrEqual(69.0);
            expect(ship.lng).toBeGreaterThanOrEqual(15.0);
            expect(ship.lng).toBeLessThanOrEqual(16.0);
        }
    });

    it('serves the vessels it remembers, with their trails, on a cold cache while BarentsWatch is unreachable', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'a-token', expires_in: 3600 }))
            .mockResolvedValueOnce(jsonResponse(combinedFixture));
        vi.stubGlobal('fetch', fetchMock);
        // As above: the shared snapshot must be forbidden from answering
        // through the outage, or the remembered-vessels path is never
        // reached and this test would pass vacuously.
        const app = buildTestApp({
            barentswatchClientId: 'client-id',
            barentswatchClientSecret: 'client-secret',
            shipsCacheTtlMs: 10,
            shipsSnapshotRefreshMs: 10,
            shipsSnapshotMaxStaleMs: 0,
        });

        // One good response fills the BFF's memory...
        const warm = await app.inject({ method: 'GET', url: `/api/ships?${VALID_BBOX}` });
        expect(warm.statusCode).toBe(200);
        const remembered = ShipsResponseSchema.parse(warm.json());
        if (!remembered.configured) throw new Error('expected a configured response');
        expect(remembered.ships.length).toBeGreaterThan(0);

        // ...then the upstream goes down AND this viewport's cache expires,
        // which is a cold load during an outage: previously a 502 and a
        // blank map. A neighbouring viewport is used to make the cache miss
        // unambiguous rather than relying on TTL timing alone.
        await sleep(20);
        fetchMock.mockRejectedValue(new Error('network down'));

        const cold = await app.inject({ method: 'GET', url: '/api/ships?bbox=15.05,68.55,15.95,68.95' });

        expect(cold.statusCode).toBe(200);
        const body = ShipsResponseSchema.parse(cold.json());
        if (!body.configured) throw new Error('expected a configured response');
        expect(body.ships.length).toBeGreaterThan(0);
        // Each vessel still carries its own fix timestamp, so the map can
        // fade and account for them as the stale positions they are.
        expect(body.ships.every((ship) => typeof ship.timestamp === 'string')).toBe(true);
    });

    it('responds 502 on a cold cache when BarentsWatch is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const app = buildTestApp({ barentswatchClientId: 'client-id', barentswatchClientSecret: 'client-secret' });

        const response = await app.inject({ method: 'GET', url: `/api/ships?${VALID_BBOX}` });

        expect(response.statusCode).toBe(502);
    });

    it('never leaks the client secret or bearer token into a 502 response body', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const app = buildTestApp({ barentswatchClientId: 'client-id', barentswatchClientSecret: 'the-real-secret-value' });

        const response = await app.inject({ method: 'GET', url: `/api/ships?${VALID_BBOX}` });

        expect(response.body).not.toContain('the-real-secret-value');
    });
});
