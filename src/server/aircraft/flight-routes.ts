/**
 * Where a flight came from and where it is going, resolved from its
 * callsign against adsbdb (https://api.adsbdb.com, keyless and free).
 *
 * An ADS-B broadcast carries no route at all: an aircraft transmits who it
 * is, where it is and how fast, and nothing about its schedule. The route
 * is therefore a second upstream's answer, keyed on the callsign the first
 * one reported -- which is why it is optional everywhere downstream and
 * why nothing waits for it.
 *
 * Three properties this is built around, all of them about not leaning on
 * a free service:
 *
 * - **Nothing blocks.** `attach` answers from the cache it already has and
 *   starts at most `MAX_LOOKUPS_PER_CALL` background fetches for what it
 *   does not. A callsign first seen on one poll therefore shows its route
 *   on the next one, ten seconds later, rather than delaying the whole
 *   aircraft layer behind a third-party request.
 * - **A callsign is asked about once.** Routes are effectively static --
 *   WIF817 flies Bodø-Sandnessjøen today and did yesterday -- so answers
 *   are cached for `ROUTE_TTL_MS`, and a stale entry is still served while
 *   its refresh runs. A "no such callsign" is cached exactly like a hit,
 *   which is what stops every private aircraft in the sky being asked
 *   about on every single poll.
 * - **Failure is invisible.** A lookup that errors caches nothing and is
 *   simply retried the next time that aircraft is seen; the aircraft is
 *   served without a route in the meantime. adsbdb being down must not
 *   take the map's planes with it.
 */
import { z } from 'zod';
import type { Aircraft, FlightRoute } from '../../shared/schemas/aircraft.js';
import { TtlCache } from '../cache.js';

/** Routes change with an airline's timetable, not with the hour. A long life here is what keeps this to a handful of requests a day. */
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Distinct callsigns remembered at once. Generous: a busy day over
 * Vesterålen is a few dozen, and the LRU cap exists to bound a
 * long-running kiosk rather than to be reached.
 */
const MAX_CACHED_CALLSIGNS = 2_000;

/**
 * New callsigns looked up per response. A bound on this app's own request
 * rate against a free service: even a sky full of unfamiliar aircraft
 * costs six requests per poll, and the rest are picked up on the polls
 * after.
 */
const MAX_LOOKUPS_PER_CALL = 6;

const ADSBDB_CALLSIGN_URL = 'https://api.adsbdb.com/v0/callsign/';

/**
 * adsbdb's airport shape. Every field is optional but `iata_code`/
 * `icao_code`: this reads three of them and lets a missing one fall back
 * rather than rejecting the whole answer.
 */
const AdsbdbAirportSchema = z.object({
    iata_code: z.string().optional(),
    icao_code: z.string().optional(),
    name: z.string().optional(),
    municipality: z.string().optional(),
});

const AdsbdbResponseSchema = z.object({
    response: z.object({
        flightroute: z.object({
            airline: z.object({ name: z.string().optional() }).optional(),
            origin: AdsbdbAirportSchema,
            destination: AdsbdbAirportSchema,
        }),
    }),
});

type AdsbdbAirport = z.infer<typeof AdsbdbAirportSchema>;

/**
 * A callsign worth asking about: `AAA1234`-ish, which is what a scheduled
 * flight's ICAO callsign looks like.
 *
 * The filter matters more than it looks. `provider.ts` falls back to the
 * ICAO hex address when a broadcast carries no flight id, so a great many
 * "callsigns" here are really `4aca75`; and a private aircraft's callsign
 * is its own registration (`LN-ABC`). Neither will ever resolve, and both
 * would otherwise be a request each.
 */
function looksLikeFlightCallsign(callsign: string, icao: string): boolean {
    if (callsign.toLowerCase() === icao.toLowerCase()) return false;
    return /^[A-Z]{2,3}[0-9][0-9A-Z]{0,3}$/.test(callsign.toUpperCase());
}

/** A string with something in it, or `undefined` -- so a field that is present but blank falls back the same way an absent one does. */
function blankAsAbsent(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** adsbdb's airport, narrowed to what a wall display can use. `undefined` when it carries no code at all, which is what makes the route unusable rather than half-drawn. */
function toAirport(raw: AdsbdbAirport): { code: string; name: string; municipality: string } | undefined {
    // IATA first -- `BOO` is what a departure board says -- and the ICAO
    // code only where a field has no IATA code at all.
    const code = blankAsAbsent(raw.iata_code) ?? blankAsAbsent(raw.icao_code);
    if (code === undefined) return undefined;

    // Normalised to `undefined` before either is used as the other's
    // fallback: a whitespace-only field left as `''` would satisfy `??`
    // and render the popup as " (ENSS)".
    const name = blankAsAbsent(raw.name);
    const municipality = blankAsAbsent(raw.municipality);
    return {
        code,
        // Each falls back to the other, and both to the code: a route that
        // says "ENSS" is still a useful thing to read, and a blank line is
        // not.
        name: name ?? municipality ?? code,
        municipality: municipality ?? name ?? code,
    };
}

export interface FlightRouteLookupOptions {
    /** Bounded deadline, as everywhere else in the BFF -- always `config.upstreamTimeoutMs` in production. */
    upstreamTimeoutMs: number;
    fetchImpl?: typeof fetch;
}

export interface FlightRouteLookup {
    /**
     * The same aircraft, each carrying its route where one is already
     * known, with lookups started in the background for the rest.
     */
    attach(aircraft: readonly Aircraft[]): Aircraft[];
    /** Settles once every lookup currently in flight has finished -- for tests, which cannot otherwise observe fire-and-forget work. */
    settled(): Promise<void>;
}

export function createFlightRouteLookup(options: FlightRouteLookupOptions): FlightRouteLookup {
    const fetchImpl = options.fetchImpl ?? fetch;
    // `null` is a real, cacheable answer: "adsbdb does not know this
    // callsign". Only a failed request leaves nothing behind.
    const cache = new TtlCache<FlightRoute | null>(ROUTE_TTL_MS, { maxEntries: MAX_CACHED_CALLSIGNS });
    const inFlight = new Set<Promise<unknown>>();

    async function lookup(callsign: string): Promise<FlightRoute | null> {
        const response = await fetchImpl(`${ADSBDB_CALLSIGN_URL}${encodeURIComponent(callsign)}`, {
            headers: { 'User-Agent': 'area-overview-bff/0.1' },
            signal: AbortSignal.timeout(options.upstreamTimeoutMs),
        });
        // 404 is adsbdb's "unknown callsign" -- an answer, not a failure,
        // and cached as one so the same aircraft is not asked about again
        // on every poll for as long as it is on screen.
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`adsbdb responded with status ${String(response.status)}`);

        const parsed = AdsbdbResponseSchema.safeParse(await response.json());
        // Thrown, not returned as "no route": a payload this cannot read
        // is adsbdb misbehaving, and caching that as a definitive answer
        // would blank the callsign's route for six hours over what may be
        // a momentary error page. A throw caches nothing, so the next poll
        // that sees the aircraft asks again -- bounded by the
        // `MAX_LOOKUPS_PER_CALL` cap, exactly like a network failure.
        if (!parsed.success) throw new Error('adsbdb returned a route payload that failed schema validation');

        const { airline, origin, destination } = parsed.data.response.flightroute;
        const from = toAirport(origin);
        const to = toAirport(destination);
        if (!from || !to) return null;
        return { airline: airline?.name, origin: from, destination: to };
    }

    function scheduleLookup(callsign: string): void {
        // `getOrLoad` is single-flight per key, so a callsign already being
        // fetched is joined rather than fetched twice.
        const pending = cache
            .getOrLoad(callsign, () => lookup(callsign))
            // Swallowed deliberately: this is fire-and-forget work with no
            // request left to fail, and an unhandled rejection here would
            // take the process down. Nothing is cached, so the next poll
            // that sees this aircraft tries again.
            .catch(() => null)
            .finally(() => inFlight.delete(pending));
        inFlight.add(pending);
    }

    return {
        attach(aircraft: readonly Aircraft[]): Aircraft[] {
            let started = 0;
            return aircraft.map((item) => {
                const callsign = item.callsign.trim().toUpperCase();
                if (!looksLikeFlightCallsign(callsign, item.icao)) return item;

                const cached = cache.get(callsign);
                if ((cached === undefined || cached.stale) && started < MAX_LOOKUPS_PER_CALL) {
                    scheduleLookup(callsign);
                    started += 1;
                }
                // A stale route is still served: an airline's timetable
                // does not turn over while a refresh is in flight, and a
                // route blinking off the popup would be worse than one a
                // few hours old.
                return cached?.value ? { ...item, route: cached.value } : item;
            });
        },
        async settled(): Promise<void> {
            while (inFlight.size > 0) await Promise.all([...inFlight]);
        },
    };
}
