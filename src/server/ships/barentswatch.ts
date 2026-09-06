/**
 * The BarentsWatch AIS client: `GET /v1/latest/combined` (nationwide, no
 * bbox filter of its own) mapped onto the app's shared `Ship` shape.
 *
 * Endpoint choice, verified against a real third-party client's source
 * (`github.com/ilder-as/go-barentswatch-ais`) and a blog post with real
 * curl examples: `GET /v1/latest/combined` returns `CombinedSimpleJson`
 * per ship, which includes `name` -- the popup spec needs a ship's name,
 * and the separate `POST /v1/latest/ais` endpoint (which does accept a
 * `geometry` filter) only returns raw position pings with no name. So
 * this client deliberately takes the "fetch nationwide, filter
 * ourselves" path rather than a filtered-but-nameless one.
 *
 * NOT attempted here: `POST https://live.ais.barentswatch.no/v1/latest/combined`
 * with a `{geometry, modelFormat, modelType}` body. That exact body shape
 * is confirmed for the *sibling* `POST /v1/combined` endpoint's
 * `CombinedFilterInput`, not confirmed for `/v1/latest/combined`
 * specifically, and there were no real BarentsWatch credentials available
 * in the environment this was built in to test it against. A future
 * contributor with real credentials could try it as an optimization: if
 * it 404s/405s/400s, that confirms this endpoint doesn't accept `POST`
 * and the `GET` + client-side-filter approach below is the only option;
 * if it works, it would remove the need to fetch+filter the whole
 * nationwide array on every cache miss.
 */
import { z } from 'zod';
import { ShipSchema, type Ship } from '../../shared/schemas/ships.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Bbox } from '../layers/bbox.js';
import type { BarentsWatchToken } from './token.js';

const COMBINED_URL = 'https://live.ais.barentswatch.no/v1/latest/combined';

/**
 * `CombinedSimpleJson` -- verified real field list (see this file's doc
 * comment). Unknown fields (e.g. `CombinedFullJson`-only fields like
 * `callSign`/`destination`) are stripped by this schema's default
 * tolerant-object behaviour, never validated against, since this app
 * doesn't need them.
 */
const RawShipSchema = z.object({
    mmsi: z.number(),
    name: z.string().nullable(),
    msgtime: z.string(),
    latitude: z.number().nullish(),
    longitude: z.number().nullish(),
    speedOverGround: z.number().nullish(),
    courseOverGround: z.number().nullish(),
    trueHeading: z.number().nullish(),
    shipType: z.number().nullish(),
    /**
     * ITU-R M.1371 AIS navigational status (0-15). Verified as a real,
     * always-present field via a live check against the real
     * `GET /v1/latest/combined` endpoint with real BarentsWatch
     * credentials on 2026-09-06: present and non-null across all 4123
     * live entries checked, `0` ("under way using engine") the plurality
     * (2599 of 4123). `.nullish()` here anyway, matching this schema's
     * existing convention for other AIS fields (e.g. `trueHeading`) --
     * defensive against a future upstream change, not because it was
     * ever observed missing.
     */
    navigationalStatus: z.number().nullish(),
});

export type RawShip = z.infer<typeof RawShipSchema>;

const RawShipsResponseSchema = z.array(RawShipSchema);

/** AIS's own "not available" sentinel for `trueHeading` (a 9-bit field, 511 = all-ones). */
const HEADING_NOT_AVAILABLE = 511;

/**
 * Maps one raw `CombinedSimpleJson` entry to the shared `Ship` shape.
 * `speedOverGround`/`courseOverGround` are typed as plain (non-nullable)
 * `number` on the shared schema (a Phase 1 decision this client doesn't
 * revisit), so a `null` upstream value becomes `0` here rather than
 * widening that schema.
 */
function toShip(raw: RawShip): Ship | undefined {
    if (raw.latitude == null || raw.longitude == null) return undefined; // can't place on the map

    const heading = raw.trueHeading == null || raw.trueHeading === HEADING_NOT_AVAILABLE ? null : raw.trueHeading;

    const candidate = {
        mmsi: String(raw.mmsi),
        name: raw.name ?? '', // null names map to empty string; UI fallback displays "Ukjent"/"Unknown"
        lat: raw.latitude,
        lng: raw.longitude,
        speedOverGround: raw.speedOverGround ?? 0,
        courseOverGround: raw.courseOverGround ?? 0,
        heading,
        shipType: raw.shipType == null ? null : String(raw.shipType),
        navigationalStatus: raw.navigationalStatus ?? null,
        timestamp: raw.msgtime,
    };

    const parsed = ShipSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
}

function withinBbox(ship: Ship, bbox: Bbox): boolean {
    return ship.lat >= bbox.minLat && ship.lat <= bbox.maxLat && ship.lng >= bbox.minLng && ship.lng <= bbox.maxLng;
}

/** Pure mapping step, exported for fixture-based schema tests that don't need a real (or mocked) network call. */
export function mapRawShipsToShips(rawShips: readonly RawShip[], bbox: Bbox): Ship[] {
    const ships: Ship[] = [];
    for (const raw of rawShips) {
        const ship = toShip(raw);
        if (ship && withinBbox(ship, bbox)) ships.push(ship);
    }
    return ships;
}

async function requestCombined(token: string, upstreamTimeoutMs: number, fetchImpl: typeof fetch): Promise<Result<Response>> {
    try {
        const response = await fetchImpl(COMBINED_URL, {
            headers: { Authorization: `Bearer ${token}` },
            // Also bounds a stalled `response.json()` read below: aborting
            // the underlying request/response also rejects any pending read
            // of its body, so one signal covers the whole request lifecycle.
            signal: AbortSignal.timeout(upstreamTimeoutMs),
        });
        return ok(response);
    } catch {
        return err({ message: 'BarentsWatch combined-AIS request failed (network error)' });
    }
}

/**
 * Fetches every ship BarentsWatch currently knows about, filters to
 * `bbox` server-side (see this file's doc comment for why), and maps the
 * survivors onto the shared `Ship` shape. On a `401` the token is
 * invalidated and the request retried exactly once with a fresh token;
 * a second failure is returned as an error, never retried further.
 */
export async function fetchShips(
    bbox: Bbox,
    token: BarentsWatchToken,
    upstreamTimeoutMs: number,
    fetchImpl: typeof fetch = fetch,
): Promise<Result<Ship[]>> {
    const tokenResult = await token.getToken();
    if (!tokenResult.ok) return tokenResult;

    let response = await requestCombined(tokenResult.value, upstreamTimeoutMs, fetchImpl);
    if (!response.ok) return response;

    if (response.value.status === 401) {
        token.invalidate();
        const retryToken = await token.getToken();
        if (!retryToken.ok) return retryToken;
        response = await requestCombined(retryToken.value, upstreamTimeoutMs, fetchImpl);
        if (!response.ok) return response;
    }

    if (!response.value.ok) {
        return err({ message: `BarentsWatch combined-AIS endpoint responded with status ${String(response.value.status)}` });
    }

    let body: unknown;
    try {
        body = await response.value.json();
    } catch {
        return err({ message: 'BarentsWatch combined-AIS endpoint returned a non-JSON body' });
    }

    const parsed = RawShipsResponseSchema.safeParse(body);
    if (!parsed.success) {
        return err({ message: 'BarentsWatch combined-AIS endpoint response failed schema validation' });
    }

    return ok(mapRawShipsToShips(parsed.data, bbox));
}
