import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';
import { TrailSchema } from './trail.js';

/**
 * The app's own normalised aircraft shape -- unconnected to any specific
 * ADS-B provider's raw response (that mapping is a later phase's job).
 * Aircraft on the ground report altitude as the literal string `'ground'`
 * rather than a number.
 */
/**
 * One end of a flight's route. `municipality` is the town the airport
 * serves ("Bodø") and `name` the airport's own ("Bodø Airport") -- the
 * first is what a passer-by reads off a wall display, the second is what
 * makes it unambiguous when several airports serve one town.
 */
export const AirportSchema = z.object({
    /** IATA code (`BOO`), the short form every departure board uses. Absent from some small fields, in which case this is the ICAO code instead. */
    code: z.string(),
    name: z.string(),
    municipality: z.string(),
});

export type Airport = z.infer<typeof AirportSchema>;

/**
 * Where a flight came from and where it is going, looked up from its
 * callsign (see `src/server/aircraft/flight-routes.ts`). Never part of an
 * ADS-B broadcast itself -- an aircraft transmits its callsign, position
 * and velocity, and nothing at all about its schedule -- so this is
 * always a second source's answer about a third party's flight number,
 * and always optional: most aircraft are not scheduled flights, and a
 * lookup that has not come back yet simply omits it.
 */
export const FlightRouteSchema = z.object({
    /** The operator's name ("Widerøe"), when known. */
    airline: z.string().optional(),
    origin: AirportSchema,
    destination: AirportSchema,
});

export type FlightRoute = z.infer<typeof FlightRouteSchema>;

export const AircraftSchema = z.object({
    icao: z.string(),
    callsign: z.string(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    altitudeFt: z.union([z.number(), z.literal('ground')]),
    groundSpeedKt: z.number(),
    track: z.number(),
    timestamp: IsoTimestampSchema,
    /** Tail number ("LN-WDL"), when the feed carries one. Optional because OpenSky's state vectors have no such field at all. */
    registration: z.string().optional(),
    /** ICAO type designator ("DH8D", "A20N"), when the feed carries one -- same caveat as `registration`. */
    aircraftType: z.string().optional(),
    /** Barometric climb rate in feet per minute, positive up. Optional: only the v2-style feeds report it, and only for aircraft transmitting it. */
    verticalRateFpm: z.number().optional(),
    /** Where this flight is going, when its callsign could be resolved to a scheduled route -- see `FlightRouteSchema`. */
    route: FlightRouteSchema.optional(),
    /** Recent earlier positions, oldest first, remembered by the BFF -- see `trail.ts`. Named `trail`, not `track`, because `track` above is already this aircraft's course over ground. */
    trail: TrailSchema.default([]),
});

export type Aircraft = z.infer<typeof AircraftSchema>;

/**
 * The ADS-B providers `src/server/aircraft/provider.ts` can query. Kept
 * here (not just server-side) because the response below needs to say
 * which of these actually produced this response's data, for the map
 * footer's attribution credit.
 */
export const AdsbSourceSchema = z.enum(['adsblol', 'airplaneslive', 'adsbfi', 'opensky']);
export type AdsbSource = z.infer<typeof AdsbSourceSchema>;

export const AircraftResponseSchema = z.discriminatedUnion('configured', [
    z.object({
        configured: z.literal(true),
        aircraft: z.array(AircraftSchema),
        fetchedAt: IsoTimestampSchema,
        /**
         * The provider(s) that genuinely contributed to `aircraft` --
         * never merely what `ADSB_PROVIDER` is set to. Optional so an
         * older server (field never sent) and a response served from the
         * BFF's own remembered-aircraft fallback (no live source actually
         * answered) both read the same way: the web layer falls back to
         * its own hard-coded attribution when this is absent.
         */
        sources: z.array(AdsbSourceSchema).optional(),
    }),
    z.object({
        configured: z.literal(false),
    }),
]);

export type AircraftResponse = z.infer<typeof AircraftResponseSchema>;
