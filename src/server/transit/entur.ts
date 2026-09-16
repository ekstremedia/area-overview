/**
 * The one place this app talks to Entur's realtime vehicles API
 * (`api.entur.io/realtime/v1/vehicles/graphql`), for the transit layer's
 * buses and ferries. Keyless: `ET-Client-Name` identifies the caller by
 * convention, not a credential, so there is no token dance here at all --
 * only a query, a timeout and a tolerant parse. Same shape as
 * `roads/vegvesen-wfs.ts`: an injected `fetchImpl`, a shared outbound gate
 * checked before anything is sent, and raw records handed back untyped so
 * `transit/vehicles.ts` is the only place that decides what a malformed
 * one costs.
 *
 * Three things about this API are traps, all probed live on 2026-09-15
 * and all pinned by tests rather than left to memory:
 *
 *  - **`Line` exposes `lineName`, not `name`.** **`Operator` exposes
 *    `operatorRef`, not `name`.** Asking for either wrong field name does
 *    not fail gracefully -- it fails the WHOLE query with a
 *    `FieldUndefined` GraphQL validation error, `data: null`, and HTTP
 *    200. That is indistinguishable from "no vehicles in this bbox"
 *    unless the response is checked for a top-level `errors` array, which
 *    is exactly the next trap.
 *  - **HTTP 200 with a top-level `errors` array is an upstream failure**,
 *    not an empty result. `fetchVehicles` treats it as one.
 *  - `speed` is `null` in practice on every record probed, and is not
 *    part of `TransitVehicle` at all -- `vehicles.ts` never reads it.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';
import type { Bbox } from '../layers/bbox.js';
import type { OutboundGate } from '../outbound-gate.js';

export const ENTUR_VEHICLES_URL = 'https://api.entur.io/realtime/v1/vehicles/graphql';

/** Reported when the Entur gate is shut, so a route can tell this apart from an upstream that actually failed. */
const GATE_CLOSED_MESSAGE = 'Entur vehicles request skipped: outbound rate gate is closed';

/**
 * The GraphQL query for one viewport. Field selection matches the
 * ground-truth probe exactly -- `lineName`/`operatorRef`, never
 * `name` on either type (see this file's header) -- and `boundingBox`
 * takes `minLat`/`minLon`/`maxLat`/`maxLon`, Entur's own field names
 * (not this app's `Bbox` shape, which spells longitude `minLng`).
 */
export function vehiclesQuery(bbox: Bbox): string {
    return `{ vehicles(boundingBox:{minLat:${String(bbox.minLat)} minLon:${String(bbox.minLng)} maxLat:${String(bbox.maxLat)} maxLon:${String(bbox.maxLng)}}) { vehicleId mode monitored delay speed bearing lastUpdated expiration originName destinationName location{latitude longitude} line{lineRef publicCode lineName} operator{operatorRef} codespace{codespaceId} } }`;
}

/**
 * One vehicle record, kept as an untyped bag. Deliberately untyped here,
 * the same split `vegvesen-wfs.ts`/`situations.ts` use for road
 * situations: `vehicles.ts` is the only place that validates the fields
 * it actually reads and counts what does not parse, so an upstream field
 * this app does not use can change shape without costing the response.
 * An array entry that is not a plain object at all (never seen live, but
 * cheap to be right about) becomes `null` rather than failing the batch.
 */
const RawVehicleRecordSchema = z.record(z.string(), z.unknown()).nullable().catch(null);

export type RawVehicleRecord = z.infer<typeof RawVehicleRecordSchema>;

/**
 * The GraphQL envelope. `data` is nullable/absent on its own (a query
 * that fails validation returns `data: null`), and `errors`, when
 * present and non-empty, is what makes that failure detectable -- see
 * this file's header.
 */
const VehiclesGraphqlSchema = z.object({
    data: z
        .object({ vehicles: z.array(RawVehicleRecordSchema).nullish() })
        .nullable()
        .catch(null),
    errors: z.array(z.unknown()).nullish(),
});

export interface FetchVehiclesOptions {
    /** Bounded deadline for the request -- `config.upstreamTimeoutMs` in production. */
    upstreamTimeoutMs: number;
    /** Identifies this app to Entur via `ET-Client-Name` -- `config.enturClientName`. */
    clientName: string;
    /**
     * The process-wide Entur outbound budget (`outbound-gate.ts`). A
     * refusal is reported as an ordinary `Result` error so the route
     * takes the same stale-then-502 path an upstream outage already
     * takes.
     */
    gate?: OutboundGate | undefined;
    fetchImpl?: typeof fetch;
}

/** Fetches the raw vehicle records inside `bbox`. Mapping onto `TransitVehicle` -- including the mode and age filters -- is `transit/vehicles.ts`'s job. */
export async function fetchVehicles(bbox: Bbox, options: FetchVehiclesOptions): Promise<Result<RawVehicleRecord[]>> {
    const fetchImpl = options.fetchImpl ?? fetch;

    // Checked before the request is built: a refusal must cost nothing.
    if (options.gate && !options.gate.tryTake()) {
        return err({ message: GATE_CLOSED_MESSAGE });
    }

    let response: Response;
    try {
        response = await fetchImpl(ENTUR_VEHICLES_URL, {
            method: 'POST',
            headers: { 'ET-Client-Name': options.clientName, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: vehiclesQuery(bbox) }),
            signal: AbortSignal.timeout(options.upstreamTimeoutMs),
        });
    } catch {
        return err({ message: 'Entur vehicles request failed (network error)' });
    }
    if (!response.ok) {
        return err({ message: `Entur vehicles endpoint responded with status ${String(response.status)}` });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return err({ message: 'Entur vehicles endpoint returned a non-JSON body' });
    }

    const parsed = VehiclesGraphqlSchema.safeParse(body);
    if (!parsed.success) {
        return err({ message: 'Entur vehicles response failed schema validation', cause: parsed.error });
    }

    // A 200 with a top-level `errors` array is a GraphQL validation or
    // execution failure -- `data` is `null` alongside it -- and must
    // never be read as "zero vehicles in this bbox", a perfectly
    // plausible answer that would otherwise hide the failure completely.
    if (parsed.data.errors && parsed.data.errors.length > 0) {
        return err({ message: 'Entur vehicles endpoint returned GraphQL errors', cause: parsed.data.errors });
    }

    return ok(parsed.data.data?.vehicles ?? []);
}
