/**
 * The `LiveLayerSpec<T>` contract: the one shape every live map layer
 * (ships, aircraft, and any future live layer -- "everything interesting
 * I can put on a map") declares itself through. This is deliberately a
 * shared-side *type* contract, not a runtime service either side has to
 * call through: the server routes (`src/server/routes/ships.ts`,
 * `aircraft.ts`) and the web layer mounts (`src/web/pages/map/ships.ts`,
 * `aircraft.ts`) each read the one concrete `LiveLayerSpec` object below
 * that concerns them, for the handful of facts that must never drift
 * between the two sides of the same feature: its `id` (used in both the
 * `/api/<id>` route path and the `settings.<id>` key), its shared Zod
 * response schema, and its default poll cadence.
 *
 * A third layer copies `SHIPS_LAYER`/`AIRCRAFT_LAYER`'s shape: declare a
 * `LiveLayerSpec<TheNewResponseType>` here, add a matching
 * `settings.<id>` block to `SettingsSchema`, and a server route +
 * web-layer module that both reference it -- no change to this file's
 * *shape*, just one more constant.
 */
import type { ZodType } from 'zod';
import { AircraftResponseSchema, type AircraftResponse } from './schemas/aircraft.js';
import { ShipsResponseSchema, type ShipsResponse } from './schemas/ships.js';

export interface LiveLayerSpec<T> {
    /** Used verbatim as the `/api/<id>` route path segment and the `settings.<id>` key. */
    id: string;
    /** The shared Zod schema for this layer's `/api/<id>` response envelope (a `{configured:true,...} | {configured:false}` discriminated union). */
    schema: ZodType<T>;
    /** This layer's own default poll interval, in seconds -- matches `SettingsSchema`'s `.default(...)` for `settings.<id>.pollSeconds`. */
    defaultPollSeconds: number;
    /**
     * A hard floor on poll cadence the web layer must never go below,
     * regardless of what a configured `pollSeconds` says -- e.g.
     * aircraft's ADS-B providers ask for roughly one request/second of
     * fair use, so no single kiosk client may poll faster than every 5s.
     * Ships has no floor beyond its own schema-enforced 10-120s range, so
     * this equals `SettingsSchema`'s own minimum for that layer.
     */
    minPollSeconds: number;
    /** Attribution text this layer contributes to the map page's footer while active. */
    attribution: string;
}

export const SHIPS_LAYER: LiveLayerSpec<ShipsResponse> = {
    id: 'ships',
    schema: ShipsResponseSchema,
    defaultPollSeconds: 15,
    minPollSeconds: 10,
    attribution: 'Data: Kystverket / BarentsWatch',
};

export const AIRCRAFT_LAYER: LiveLayerSpec<AircraftResponse> = {
    id: 'aircraft',
    schema: AircraftResponseSchema,
    defaultPollSeconds: 10,
    minPollSeconds: 5,
    attribution: 'Data: adsb.lol',
};
