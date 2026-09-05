import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

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
});

export type Aircraft = z.infer<typeof AircraftSchema>;

export const AircraftResponseSchema = z.discriminatedUnion('configured', [
    z.object({
        configured: z.literal(true),
        aircraft: z.array(AircraftSchema),
        fetchedAt: IsoTimestampSchema,
    }),
    z.object({
        configured: z.literal(false),
    }),
]);

export type AircraftResponse = z.infer<typeof AircraftResponseSchema>;
