import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

/**
 * One remembered position for a ship or aircraft: where it was, and when
 * it reported being there.
 *
 * Neither upstream serves track history -- BarentsWatch and adsb.lol each
 * answer "where is everything right now" -- so a track is something this
 * app accumulates. It is accumulated on the *server*
 * (`server/tracks/store.ts`), not in the browser, for two reasons: the
 * BFF keeps polling while nobody is looking at the map, so a trail is
 * already there when the kiosk cycles back to it; and it survives leaving
 * the map page, which a browser-side history could not.
 *
 * `at` is the vessel's own reported timestamp, not when this app noticed
 * it -- an upstream that re-serves a stale fix must not look like fresh
 * movement.
 */
export const TrailPointSchema = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    at: IsoTimestampSchema,
});

export type TrailPoint = z.infer<typeof TrailPointSchema>;

/**
 * A vessel's recent positions, oldest first, excluding its current one.
 * Empty is the normal state for anything the server has only just seen,
 * and for anything that has not moved.
 */
export const TrailSchema = z.array(TrailPointSchema);
