import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bbox } from '../layers/bbox.js';
import { createOutboundGate } from '../outbound-gate.js';
import vehiclesFixture from './fixtures/entur-vehicles-vesteralen.json' with { type: 'json' };
import { ENTUR_VEHICLES_URL, fetchVehicles, vehiclesQuery } from './entur.js';

/** The Vesterålen box from the fixtures' README. */
const VESTERALEN: Bbox = { minLat: 68.35, minLng: 14.5, maxLat: 69.05, maxLng: 16.5 };

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('vehiclesQuery', () => {
    it("builds the boundingBox with Entur's own field names", () => {
        // The trap this pins: Entur's `boundingBox` input spells longitude
        // `minLon`/`maxLon`, not this app's own `Bbox.minLng`/`maxLng`.
        const query = vehiclesQuery(VESTERALEN);

        expect(query).toContain('minLat:68.35');
        expect(query).toContain('minLon:14.5');
        expect(query).toContain('maxLat:69.05');
        expect(query).toContain('maxLon:16.5');
    });

    it('asks for lineName and operatorRef, never name on either type', () => {
        // The other probed trap: `Line.name`/`Operator.name` fail the
        // WHOLE query with a FieldUndefined error. Pinned as a literal so
        // a future edit can't reintroduce it.
        const query = vehiclesQuery(VESTERALEN);

        expect(query).toContain('lineName');
        expect(query).toContain('operatorRef');
        expect(query).not.toMatch(/line\s*\{[^}]*\bname\b/);
        expect(query).not.toMatch(/operator\s*\{[^}]*\bname\b/);
    });
});

describe('fetchVehicles', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the raw vehicle records for a successful response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture));

        const result = await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(vehiclesFixture.data.vehicles.length);
        expect(result.value[0]?.vehicleId).toBe('3390101274');
    });

    it('POSTs once per call, carrying ET-Client-Name and the bbox', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture));

        await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', fetchImpl: fetchMock });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(ENTUR_VEHICLES_URL);
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['ET-Client-Name']).toBe('area-overview-test');
        const body = JSON.parse(init.body as string) as { query: string };
        expect(body.query).toContain('minLat:68.35');
        expect(body.query).toContain('maxLon:16.5');
    });

    it('treats a 200 response carrying a top-level errors array as a failure, not zero vehicles', async () => {
        // The trap this app must not fall into: a FieldUndefined error (or
        // any other GraphQL validation/execution failure) still answers
        // 200 with `data: null` -- reading that as "no vehicles here" is
        // indistinguishable from a quiet bbox and would hide the failure
        // completely.
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({
                data: null,
                errors: [{ message: "Cannot query field 'name' on type 'Line'." }],
            }),
        );

        const result = await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', fetchImpl: fetchMock });

        expect(result.ok).toBe(false);
    });

    it('treats a response with neither data nor errors as a failure, not zero vehicles', async () => {
        // Distinct from the `errors`-array case above: this is a malformed
        // response with no signal at all, not a documented GraphQL failure
        // shape -- both must be told apart from a genuine empty bbox.
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));

        const result = await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', fetchImpl: fetchMock });

        expect(result.ok).toBe(false);
    });

    it('treats data:null with no errors as a failure, not zero vehicles', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: null }));

        const result = await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', fetchImpl: fetchMock });

        expect(result.ok).toBe(false);
    });

    it('treats data: { vehicles: null } as a legitimate empty answer, not a failure', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { vehicles: null } }));

        const result = await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toEqual([]);
    });

    it('reports a network failure as an error', async () => {
        const result = await fetchVehicles(VESTERALEN, {
            upstreamTimeoutMs: 1000,
            clientName: 'area-overview-test',
            fetchImpl: vi.fn().mockRejectedValue(new Error('network down')),
        });

        expect(result.ok).toBe(false);
    });

    it('keeps the good records in a batch where one vehicle entry is malformed', async () => {
        // The failure mode this prevents: one array entry that is not a
        // plain object failing the whole batch and blanking a viewport
        // that had perfectly good vehicles in it. Validating *which*
        // fields a record carries is `transit/vehicles.ts`'s job, not
        // this one -- see this module's header.
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({
                data: {
                    vehicles: [{ vehicleId: 'good-1', mode: 'BUS' }, 'not an object', null, { vehicleId: 'good-2', mode: 'FERRY' }],
                },
            }),
        );

        const result = await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(4);
        expect(result.value[0]?.vehicleId).toBe('good-1');
        expect(result.value[1]).toBeNull();
        expect(result.value[2]).toBeNull();
        expect(result.value[3]?.vehicleId).toBe('good-2');
    });

    it('reports a network failure, a bad status and a non-JSON body as errors', async () => {
        const failed = await fetchVehicles(VESTERALEN, {
            upstreamTimeoutMs: 1000,
            clientName: 'area-overview-test',
            fetchImpl: vi.fn().mockRejectedValue(new Error('network down')),
        });
        const badStatus = await fetchVehicles(VESTERALEN, {
            upstreamTimeoutMs: 1000,
            clientName: 'area-overview-test',
            fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
        });
        const notJson = await fetchVehicles(VESTERALEN, {
            upstreamTimeoutMs: 1000,
            clientName: 'area-overview-test',
            fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
        });

        expect(failed.ok).toBe(false);
        expect(badStatus.ok).toBe(false);
        expect(notJson.ok).toBe(false);
    });

    it('reports a shut gate as an ordinary error without calling upstream', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(vehiclesFixture));
        // One token, refilled in ten minutes: the first call spends it.
        const gate = createOutboundGate({ minIntervalMs: 600_000, burst: 1 });

        const first = await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', gate, fetchImpl: fetchMock });
        const second = await fetchVehicles(VESTERALEN, { upstreamTimeoutMs: 1000, clientName: 'area-overview-test', gate, fetchImpl: fetchMock });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        // The whole point of a gate: the refusal cost nothing outbound.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
