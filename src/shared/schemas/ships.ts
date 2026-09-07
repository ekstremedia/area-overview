import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';
import { TrailSchema } from './trail.js';

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
    /** Raw ITU-R M.1371 AIS navigational status (0-15) -- see `barentswatch.ts`'s doc comment for how this was verified against real, live data. `0` = "under way using engine", coloured distinctly by `ships.ts`'s `colorFor`. */
    navigationalStatus: z.number().nullable(),
    timestamp: IsoTimestampSchema,
    /** Recent earlier positions, oldest first, remembered by the BFF -- see `trail.ts`. Defaults to empty so a response from a path that has no history to offer still parses. */
    trail: TrailSchema.default([]),
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
