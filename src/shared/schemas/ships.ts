import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

/**
 * The app's own normalised ship shape -- NOT BarentsWatch's raw AIS shape.
 * Mapping the raw upstream response onto this is a later phase's job
 * (BarentsWatch client); this schema only defines what the rest of the app
 * consumes. Always "ship", never "vessel".
 */
export const ShipSchema = z.object({
    mmsi: z.string(),
    name: z.string(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    speedOverGround: z.number(),
    courseOverGround: z.number(),
    heading: z.number().nullable(),
    shipType: z.string().nullable(),
    timestamp: IsoTimestampSchema,
});

export type Ship = z.infer<typeof ShipSchema>;

/**
 * BarentsWatch credentials are optional (see `.env.example`); when they
 * are not configured the ships layer must still return a well-formed,
 * valid response rather than an error.
 */
export const ShipsResponseSchema = z.discriminatedUnion('configured', [
    z.object({
        configured: z.literal(true),
        ships: z.array(ShipSchema),
        fetchedAt: IsoTimestampSchema,
    }),
    z.object({
        configured: z.literal(false),
    }),
]);

export type ShipsResponse = z.infer<typeof ShipsResponseSchema>;
