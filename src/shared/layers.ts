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
 * Adding a layer means declaring a `LiveLayerSpec<TheNewResponseType>`
 * here, widening `LiveLayerId` by one member, adding a matching
 * `settings.<id>` block to `SettingsSchema`, and writing a server route +
 * web-layer module that both reference the constant.
 *
 * An earlier version of this comment promised a third layer would need
 * "no change to this file's *shape*, just one more constant". The roads
 * layer broke that promise, knowingly, in two places -- so the shape is
 * now:
 *
 *  - `id` is the closed union `LiveLayerId`, not `string`. Every id is
 *    also a `Settings` key, and saying so in the type is what lets the
 *    settings page index into `Settings` without a cast asserting that
 *    correspondence in a comment.
 *  - `maxAgeMinutesMin`/`maxAgeMinutesMax` are **optional**. They bound a
 *    "hide fixes older than this" control, which presumes a layer whose
 *    items are position reports. A road situation has a validity window
 *    instead -- it is not stale at 22:00, it is `scheduled` -- so the
 *    roads layer sets neither, and the settings page renders the max-age
 *    stepper only for the layers that do.
 *
 * Everything else still generalises, and a fourth layer that *is* a
 * stream of position fixes remains one more constant.
 */
import type { ZodType } from 'zod';
import { AircraftResponseSchema, type AircraftResponse } from './schemas/aircraft.js';
import { RoadSituationsResponseSchema, type RoadSituationsResponse } from './schemas/roads.js';
import { ShipsResponseSchema, type ShipsResponse } from './schemas/ships.js';

/**
 * Every live layer's id. Closed, and deliberately so: an id is
 * simultaneously the `/api/<id>` route segment, the `settings.<id>` key
 * and the `SettingsOverride` key, so the three cannot drift apart
 * without this union rejecting the change.
 */
export type LiveLayerId = 'ships' | 'aircraft' | 'roads';

export interface LiveLayerSpec<T> {
    /** The `settings.<id>` key, and the `/api/<id>` route path segment for the layers whose data is one route. Roads is two routes (`/api/road-situations`, `/api/road-cameras`) behind this one id and one toggle. */
    id: LiveLayerId;
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
    /**
     * The upper bound on `settings.<id>.pollSeconds`/`.maxAgeMinutes` --
     * mirrors each field's own `.max()`/`.min()` in `SettingsSchema`
     * (`ShipsSettingsSchema`/`AircraftSettingsSchema`). Carried here too
     * (duplicating the schema's own bounds, deliberately) so the settings
     * page's Layers section can render a `Stepper` for every layer purely
     * by iterating this array, without naming any layer.
     */
    maxPollSeconds: number;
    /**
     * Bounds on `settings.<id>.maxAgeMinutes`, mirroring that field's own
     * `.min()`/`.max()` in `SettingsSchema` -- and **optional**, because
     * not every live layer has a fix age at all (see this file's doc
     * comment). Set both or neither: the settings page renders the
     * max-age stepper only when both are present, and a layer whose
     * settings block has no `maxAgeMinutes` field must set neither.
     */
    maxAgeMinutesMin?: number;
    maxAgeMinutesMax?: number;
    /** Attribution text this layer contributes to the map page's footer while active. */
    attribution: string;
}

export const SHIPS_LAYER: LiveLayerSpec<ShipsResponse> = {
    id: 'ships',
    schema: ShipsResponseSchema,
    defaultPollSeconds: 15,
    minPollSeconds: 10,
    maxPollSeconds: 120,
    maxAgeMinutesMin: 1,
    maxAgeMinutesMax: 120,
    attribution: 'Data: Kystverket / BarentsWatch',
};

export const AIRCRAFT_LAYER: LiveLayerSpec<AircraftResponse> = {
    id: 'aircraft',
    schema: AircraftResponseSchema,
    defaultPollSeconds: 10,
    minPollSeconds: 5,
    maxPollSeconds: 120,
    maxAgeMinutesMin: 1,
    maxAgeMinutesMax: 60,
    attribution: 'Data: adsb.lol',
};

/**
 * Statens vegvesen's road situations and road cameras -- one layer, one
 * toggle, two routes (see `id` above). The poll cadence here drives the
 * situations only; the camera roster barely changes and refreshes on its
 * own far slower fixed interval, and each still image is re-fetched by
 * the browser, costing this app's API nothing.
 *
 * No `maxAgeMinutes*`: a road notice is valid until it expires, not
 * until it goes stale. The equivalent viewer control is
 * `settings.roads.showPlanned`, which hides what is not in force right
 * now -- a filter on the future, not on the past.
 *
 * The floor of 60s is well above what the upstream needs (a viewport
 * query answers in 0.2s); it reflects how fast this data actually
 * changes. Roadworks do not move.
 */
export const ROADS_LAYER: LiveLayerSpec<RoadSituationsResponse> = {
    id: 'roads',
    schema: RoadSituationsResponseSchema,
    defaultPollSeconds: 120,
    minPollSeconds: 60,
    maxPollSeconds: 600,
    attribution: 'Data: Statens vegvesen',
};
