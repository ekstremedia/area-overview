import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';
import { TrailSchema } from './trail.js';

/**
 * The app's own normalised aircraft shape -- unconnected to any specific
 * ADS-B provider's raw response (that mapping is a later phase's job).
 * Aircraft on the ground report altitude as the literal string `'ground'`
 * rather than a number.
 */
export const AircraftSchema = z.object({
    icao: z.string(),
    callsign: z.string(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    altitudeFt: z.union([z.number(), z.literal('ground')]),
    groundSpeedKt: z.number(),
    track: z.number(),
    timestamp: IsoTimestampSchema,
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
