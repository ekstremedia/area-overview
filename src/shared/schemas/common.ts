import { z } from 'zod';

/**
 * A geographic point. Latitude/longitude ranges are validated so an
 * obviously-wrong coordinate (e.g. a swapped lat/lng) fails fast rather
 * than silently placing a marker in the ocean somewhere else on the globe.
 */
export const LatLngSchema = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
});

export type LatLng = z.infer<typeof LatLngSchema>;

/**
 * A timestamp string that must be parseable as ISO-8601. Kept as a string
 * (not coerced to `Date`) so it survives JSON round-trips unchanged and
 * callers decide when/whether to construct a `Date` from it.
 */
export const IsoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Expected an ISO-8601 timestamp string',
});

export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;
