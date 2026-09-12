/**
 * Callsign-to-route resolution against adsbdb. The behaviour worth
 * pinning here is all about restraint: nothing waits for a lookup, a
 * callsign is asked about once, and a callsign that could never resolve
 * is never asked about at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFlightRouteLookup } from './flight-routes.js';
import type { Aircraft } from '../../shared/schemas/aircraft.js';

function aircraft(overrides: Partial<Aircraft> = {}): Aircraft {
    return {
        icao: '4787aa',
        callsign: 'WIF607',
        lat: 68.7,
        lng: 15.4,
        altitudeFt: 24_000,
        groundSpeedKt: 282,
        track: 214,
        timestamp: '2026-09-12T12:00:00.000Z',
        trail: [],
        ...overrides,
    };
}

/** The shape adsbdb actually answers with, trimmed to the fields this reads (captured from a live `GET /v0/callsign/SAS4114`). */
function routeResponse(overrides: Record<string, unknown> = {}): Response {
    return new Response(
        JSON.stringify({
            response: {
                flightroute: {
                    callsign: 'WIF607',
                    airline: { name: 'Widerøe', icao: 'WIF' },
                    origin: { iata_code: 'BOO', icao_code: 'ENBO', name: 'Bodø Airport', municipality: 'Bodø' },
                    destination: { iata_code: 'TOS', icao_code: 'ENTC', name: 'Tromsø Airport', municipality: 'Tromsø' },
                    ...overrides,
                },
            },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

describe('createFlightRouteLookup', () => {
    it('answers the first call with no route at all, then carries one on the next', async () => {
        // The point of the whole module: the aircraft layer is never held
        // up behind a third party's answer about a flight number.
        const fetchMock = vi.fn().mockResolvedValue(routeResponse());
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        expect(lookup.attach([aircraft()])[0]?.route).toBeUndefined();

        await lookup.settled();
        const [attached] = lookup.attach([aircraft()]);
        expect(attached?.route?.origin).toEqual({ code: 'BOO', name: 'Bodø Airport', municipality: 'Bodø' });
        expect(attached?.route?.destination.code).toBe('TOS');
        expect(attached?.route?.airline).toBe('Widerøe');
    });

    it('asks about a callsign once, however many polls it is seen on', async () => {
        const fetchMock = vi.fn().mockResolvedValue(routeResponse());
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        lookup.attach([aircraft()]);
        await lookup.settled();
        for (let poll = 0; poll < 5; poll++) lookup.attach([aircraft()]);
        await lookup.settled();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.adsbdb.com/v0/callsign/WIF607');
    });

    it('remembers a 404 as an answer, so an unknown callsign is not re-asked on every poll', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{"response":"unknown callsign"}', { status: 404 }));
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        lookup.attach([aircraft({ callsign: 'ZZZ9999' })]);
        await lookup.settled();
        lookup.attach([aircraft({ callsign: 'ZZZ9999' })]);
        await lookup.settled();

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries after a failed request rather than caching the failure', async () => {
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValue(routeResponse());
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        lookup.attach([aircraft()]);
        await lookup.settled(); // the failure must not take the process with it

        lookup.attach([aircraft()]);
        await lookup.settled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(lookup.attach([aircraft()])[0]?.route?.destination.code).toBe('TOS');
    });

    it('never asks about a callsign that could not be a flight number', async () => {
        const fetchMock = vi.fn().mockResolvedValue(routeResponse());
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        // The hex address `provider.ts` falls back to when a broadcast
        // carries no flight id, and a private aircraft's registration --
        // neither is a scheduled flight, and both would be a request each.
        lookup.attach([aircraft({ icao: '4787aa', callsign: '4787aa' }), aircraft({ icao: '478abc', callsign: 'LN-ABC' })]);
        await lookup.settled();

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('starts at most six lookups per response, leaving the rest for the polls after', async () => {
        const fetchMock = vi.fn().mockResolvedValue(routeResponse());
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        const crowdedSky = Array.from({ length: 20 }, (_, index) =>
            aircraft({ icao: `hex${String(index)}`, callsign: `SAS${String(1000 + index)}` }),
        );
        lookup.attach(crowdedSky);
        await lookup.settled();

        expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('treats an airport with no usable code as no route at all, rather than half a route', async () => {
        const fetchMock = vi.fn().mockResolvedValue(routeResponse({ destination: { name: 'Somewhere' } }));
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        lookup.attach([aircraft()]);
        await lookup.settled();

        expect(lookup.attach([aircraft()])[0]?.route).toBeUndefined();
    });

    it('retries a payload it cannot read, rather than caching it as "this flight has no route"', async () => {
        // adsbdb answering 200 with something unreadable is it
        // misbehaving, not an answer about the flight -- caching it would
        // blank the route for six hours over a momentary error page.
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response('<html>502</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
            .mockResolvedValue(routeResponse());
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        lookup.attach([aircraft()]);
        await lookup.settled();
        lookup.attach([aircraft()]);
        await lookup.settled();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(lookup.attach([aircraft()])[0]?.route?.destination.code).toBe('TOS');
    });

    it('treats a blank airport name as absent rather than rendering an empty label', async () => {
        const fetchMock = vi.fn().mockResolvedValue(routeResponse({ origin: { iata_code: 'BOO', name: '   ', municipality: '' } }));
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        lookup.attach([aircraft()]);
        await lookup.settled();

        expect(lookup.attach([aircraft()])[0]?.route?.origin).toEqual({ code: 'BOO', name: 'BOO', municipality: 'BOO' });
    });

    it('falls back to the ICAO code and to the code as a name for a sparser airport entry', async () => {
        const fetchMock = vi.fn().mockResolvedValue(routeResponse({ origin: { icao_code: 'ENSS' } }));
        const lookup = createFlightRouteLookup({ upstreamTimeoutMs: 1_000, fetchImpl: fetchMock });

        lookup.attach([aircraft()]);
        await lookup.settled();

        expect(lookup.attach([aircraft()])[0]?.route?.origin).toEqual({ code: 'ENSS', name: 'ENSS', municipality: 'ENSS' });
    });
});
