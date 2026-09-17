import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeciesResponseSchema } from '../../shared/schemas/species.js';
import fixture from '../species/fixtures/gbif-occurrence-search-vesteralen.json' with { type: 'json' };
import { parseDaysParam } from './species.js';
import { buildTestApp, jsonResponse, sleep } from './test-helpers.js';

/** A generous Vesterålen viewport -- the exact numbers don't matter since the fetch is stubbed. */
const VALID_BBOX = 'bbox=14.5,68.35,16.5,69.05';

describe('parseDaysParam', () => {
    it("defaults to 30 for an empty string, distinct from 0's own correct 7-day bucket", () => {
        // The bug this pins: Number('') is 0, a finite value, so an empty
        // `?days=` query value must be turned away before ever reaching
        // Number() -- otherwise it silently lands on the 7-day bucket
        // instead of this function's documented 30-day default.
        expect(parseDaysParam('')).toBe(30);
    });

    it('defaults to 30 when the value is missing entirely', () => {
        expect(parseDaysParam(undefined)).toBe(30);
    });

    it("resolves an explicit '0' to the 7-day bucket -- correct, and distinct from the empty-string case above", () => {
        expect(parseDaysParam('0')).toBe(7);
    });

    it('clamps a negative value to the 7-day bucket', () => {
        expect(parseDaysParam('-5')).toBe(7);
    });

    it('clamps an oversized value to the 365-day bucket', () => {
        expect(parseDaysParam('99999')).toBe(365);
    });

    it('defaults to 30 for an unparseable string', () => {
        expect(parseDaysParam('abc')).toBe(30);
    });

    it("resolves '45' to the nearest bucket, 30", () => {
        expect(parseDaysParam('45')).toBe(30);
    });

    it("pins the current tie-break for '60' (equidistant between 30 and 90)", () => {
        // Not asserting this is the "right" tie-break, only that it stays
        // whatever it already is -- see this function's own `VALID_DAYS`
        // iteration order (first bucket closer-or-equal wins).
        expect(parseDaysParam('60')).toBe(30);
    });
});

describe('GET /api/species', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serves the mapped, grouped sightings for a viewport', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(fixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = SpeciesResponseSchema.parse(response.json());
        expect(body.configured).toBe(true);
        if (!body.configured) return;

        expect(body.sightings).toHaveLength(3);
        expect(body.truncated).toBe(false);
        expect(typeof body.fetchedAt).toBe('string');

        const bluetit = body.sightings.find((s) => s.count === 2);
        expect(bluetit).toMatchObject({ individualCount: 5, coordinateUncertaintyMeters: 50 });
    });

    it('NEVER includes recordedBy, or the fixture private name, anywhere in the serialised response body', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(fixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        // Guard the fixture itself: if this ever stops being true, the test
        // below would pass for the wrong reason (nothing to catch).
        expect(JSON.stringify(fixture)).toContain('recordedBy');
        expect(JSON.stringify(fixture)).toContain('Sonja Stavem');
        expect(JSON.stringify(fixture)).toContain('Kari Fjellheim');

        const rawBody = response.body;
        expect(rawBody).not.toContain('recordedBy');
        expect(rawBody).not.toContain('Sonja Stavem');
        expect(rawBody).not.toContain('Sonja');
        expect(rawBody).not.toContain('Stavem');
        // 'Kari Fjellheim' sits on the fixture's Amanita record -- the
        // newest (and only) record in its own group -- the stronger
        // placement per this fixture's own README/occurrences.test.ts note.
        expect(rawBody).not.toContain('Kari Fjellheim');
        expect(rawBody).not.toContain('Kari');
        expect(rawBody).not.toContain('Fjellheim');
    });

    it('responds 400 for an unparseable bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/species?bbox=nope' });

        expect(response.statusCode).toBe(400);
    });

    it('responds 400 for a missing bbox', async () => {
        vi.stubGlobal('fetch', vi.fn());
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/species' });

        expect(response.statusCode).toBe(400);
    });

    it('makes one upstream occurrence call for two requests inside the TTL', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ speciesCacheTtlMs: 60_000 });

        await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });
        const second = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        expect(second.statusCode).toBe(200);
        // 1 occurrence-search call, plus one dataset-title lookup per
        // distinct dataset key across this fixture's surviving sightings
        // (2 -- see fixtures/README.md) -- all on the FIRST request only;
        // the second is served entirely from `cache` (the whole mapped
        // response, titles included), calling upstream zero more times.
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('clamps days=45 and days=30 to the same cache key -- one upstream occurrence call for both', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ speciesCacheTtlMs: 60_000 });

        const first = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}&days=45` });
        const second = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}&days=30` });

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        // See the previous test's comment on why this is 3, not 1.
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('serves a stale answer when GBIF fails after a warm cache', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixture));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp({ speciesCacheTtlMs: 10 });

        expect((await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` })).statusCode).toBe(200);
        await sleep(20);
        fetchMock.mockRejectedValue(new Error('GBIF down'));

        const stale = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        expect(stale.statusCode).toBe(200);
        expect(stale.headers['x-cache']).toBe('stale');
        expect(stale.headers['cache-control']).toBe('no-cache');
    });

    it('responds 502 on a cold cache when GBIF is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('GBIF down')));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        expect(response.statusCode).toBe(502);
    });

    it('advertises freshness from its own TTL, never longer', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(fixture)));
        const app = buildTestApp({ speciesCacheTtlMs: 60_000 });

        const response = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        expect(response.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60');
    });

    it('serves a stale answer rather than calling upstream when the GBIF gate is shut', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixture));
        vi.stubGlobal('fetch', fetchMock);
        // One token, refilled in ten minutes: the warm-up spends it.
        const app = buildTestApp({ speciesCacheTtlMs: 10, gbifMinIntervalMs: 600_000, gbifBurst: 1 });

        expect((await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` })).statusCode).toBe(200);
        await sleep(20);

        const gated = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        expect(gated.statusCode).toBe(200);
        expect(gated.headers['x-cache']).toBe('stale');
        // All 3 calls (1 occurrence + 2 dataset-title lookups -- see the
        // "makes one upstream occurrence call" test's comment) are from the
        // warm-up; the gated second request never reaches `fetchGbifOccurrences`
        // at all, so it adds zero more.
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('keeps the bbox out of the log when the upstream fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('GBIF down')));
        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });
        await app.close();

        const output = written.join('');
        expect(output).toContain('species');
        expect(output).not.toContain('14.500');
        expect(output).not.toContain('68.350');
    });

    it('says nothing at all when every record maps cleanly', async () => {
        const cleanFixture = {
            count: 2,
            results: fixture.results.filter((r) => r.key === 1001 || r.key === 1002),
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(cleanFixture)));

        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        const response = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });
        await app.close();

        expect(response.statusCode).toBe(200);
        expect(written.join('')).toBe('');
    });

    it('warns when the mapper discards records, naming the counts and no bbox', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(fixture)));

        const written: string[] = [];
        const app = buildTestApp({}, { logger: { level: 'warn', stream: { write: (chunk: string) => written.push(chunk) } } });

        const response = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });
        await app.close();

        expect(response.statusCode).toBe(200);
        const output = written.join('');
        expect(output).toContain('GBIF occurrence records were discarded');
        expect(output).toContain('"missingEventDate":1');
        expect(output).toContain('"missingSpeciesKey":1');
        expect(output).toContain('"attributes":1');
        expect(output).not.toContain('14.500');
        expect(output).not.toContain('68.350');
    });

    it('clamps an oversized bbox rather than rejecting it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(fixture)));
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: '/api/species?bbox=-170,-80,170,80' });

        expect(response.statusCode).toBe(200);
    });

    it('populates a real dataset title from a successful lookup', async () => {
        const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
            const href = String(url);
            if (href.includes('/dataset/9ea87732-b88e-488d-a02b-3dc6e9b885e0')) {
                return Promise.resolve(jsonResponse({ title: 'Norwegian Species Observation Service' }));
            }
            if (href.includes('/dataset/')) {
                return Promise.resolve(jsonResponse({ title: 'Some Other Dataset' }));
            }
            return Promise.resolve(jsonResponse(fixture));
        });
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        const body = SpeciesResponseSchema.parse(response.json());
        expect(body.configured).toBe(true);
        if (!body.configured) return;
        const bluetit = body.sightings.find((s) => s.count === 2);
        expect(bluetit?.datasets.some((d) => d.title === 'Norwegian Species Observation Service')).toBe(true);
    });

    it('falls back to the dataset key as its own title when the dataset lookup fails, without failing the response', async () => {
        const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
            const href = String(url);
            if (href.includes('/dataset/')) {
                return Promise.reject(new Error('dataset lookup down'));
            }
            return Promise.resolve(jsonResponse(fixture));
        });
        vi.stubGlobal('fetch', fetchMock);
        const app = buildTestApp();

        const response = await app.inject({ method: 'GET', url: `/api/species?${VALID_BBOX}` });

        expect(response.statusCode).toBe(200);
        const body = SpeciesResponseSchema.parse(response.json());
        expect(body.configured).toBe(true);
        if (!body.configured) return;
        const bluetit = body.sightings.find((s) => s.count === 2);
        expect(bluetit?.datasets.some((d) => d.key === d.title)).toBe(true);
    });
});
