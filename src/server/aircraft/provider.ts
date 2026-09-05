/**
 * ADS-B aircraft client: three keyless "v2" community aggregators
 * (adsb.lol, airplanes.live, adsb.fi -- documented as shape-compatible
 * community forks of the same underlying readsb/tar1090 JSON format) plus
 * OpenSky (a genuinely different shape and auth model). All map onto the
 * app's shared `Aircraft` shape.
 *
 * The v2 providers' shape below is verified live: captured by literally
 * running `curl 'https://api.adsb.lol/v2/lat/68.6984/lon/15.4129/dist/100'`
 * during this phase's development (see
 * `src/server/aircraft/fixtures/README.md`). `airplanes.live`/`adsb.fi`
 * are NOT independently verified byte-for-byte -- the raw schema below is
 * built tolerantly (unknown fields stripped, as always) specifically so
 * minor differences between providers don't break parsing.
 *
 * OpenSky's shape is implemented best-effort from public documentation
 * only -- it was not (and, per the phase brief, deliberately not)
 * exercised against a real, repeated OpenSky query during development,
 * to avoid burning its anonymous ~400 credit/day quota. Treat this path
 * as a documented, reasonable-effort implementation a future contributor
 * with OpenSky credentials should verify against a real response.
 */
import { z } from 'zod';
import { AircraftSchema, type Aircraft } from '../../shared/schemas/aircraft.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Bbox } from '../layers/bbox.js';

export type AdsbProvider = 'adsblol' | 'airplaneslive' | 'adsbfi' | 'opensky';

const KNOTS_PER_MPS = 1.94384;
const KM_PER_DEGREE_LAT = 111;
const KM_PER_NM = 1.852;
const MIN_RADIUS_NM = 5;
const MAX_RADIUS_NM = 250; // adsb.lol's own documented maximum for `dist`

/**
 * `AircraftJsonV2`-style raw shape (adsb.lol/airplanes.live/adsb.fi).
 * Every field but `hex` is optional/tolerant: real responses include many
 * more fields this app doesn't need (already stripped by this schema's
 * default tolerant-object behaviour), and some aircraft entries lack
 * position/speed/altitude data entirely (e.g. Mode-A/C-only contacts).
 */
const RawV2AircraftSchema = z.object({
    hex: z.string(),
    flight: z.string().optional(),
    alt_baro: z.union([z.number(), z.literal('ground')]).optional(),
    gs: z.number().optional(),
    track: z.number().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    seen: z.number().optional(),
    seen_pos: z.number().optional(),
});

export type RawV2Aircraft = z.infer<typeof RawV2AircraftSchema>;

const RawV2ResponseSchema = z.object({
    ac: z.array(RawV2AircraftSchema),
});

const V2_PROVIDER_URLS: Record<'adsblol' | 'airplaneslive' | 'adsbfi', (lat: number, lon: number, nm: number) => string> = {
    adsblol: (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${String(lat)}/lon/${String(lon)}/dist/${String(nm)}`,
    airplaneslive: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${String(lat)}/${String(lon)}/${String(nm)}`,
    adsbfi: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${String(lat)}/lon/${String(lon)}/dist/${String(nm)}`,
};

export interface CenterRadius {
    lat: number;
    lon: number;
    nm: number;
}

/**
 * Converts `bbox` to a center + radius (nautical miles) for the v2
 * providers' point+radius query. The radius is the true center-to-corner
 * distance (converted km -> nm), clamped to `[MIN_RADIUS_NM,
 * MAX_RADIUS_NM]` -- generous enough that the circle fully contains the
 * requested rectangle (no corner missed), and re-filtered to the exact
 * bbox afterwards anyway (see `filterToBbox`), so a generous radius only
 * ever costs a slightly larger fetch, never a correctness problem.
 *
 * Deliberately checks BOTH distinct corner latitudes (`minLat`/`maxLat`),
 * not just the bbox's center latitude: `cos(lat)` shrinks a degree of
 * longitude toward the poles, so whichever corner is farther from the
 * equator needs a *smaller* cosine factor -- i.e. a *larger*
 * longitude-to-km conversion -- than a center-based approximation gives.
 * Using the center's cosine alone can understate the true corner
 * distance, especially at this app's high-latitude (~68-69°N) deployment.
 * The final nm value is also rounded UP (`Math.ceil`), never to nearest:
 * rounding down could shrink the radius just enough to exclude a real
 * aircraft sitting at (or just inside) the bbox's corner, and
 * `withinBbox`'s later re-filter can only ever REMOVE aircraft the
 * provider returned, never add back one it was never sent in the first
 * place.
 */
export function bboxToCenterRadius(bbox: Bbox): CenterRadius {
    const centerLat = (bbox.minLat + bbox.maxLat) / 2;
    const centerLng = (bbox.minLng + bbox.maxLng) / 2;
    const latHalfKm = ((bbox.maxLat - bbox.minLat) / 2) * KM_PER_DEGREE_LAT;
    const lngHalfDeg = (bbox.maxLng - bbox.minLng) / 2;

    const cornerKmAt = (lat: number): number => Math.hypot(latHalfKm, lngHalfDeg * KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
    const maxCornerKm = Math.max(cornerKmAt(bbox.minLat), cornerKmAt(bbox.maxLat));

    const nm = Math.min(MAX_RADIUS_NM, Math.max(MIN_RADIUS_NM, Math.ceil(maxCornerKm / KM_PER_NM)));
    return { lat: centerLat, lon: centerLng, nm };
}

function trimmedCallsign(flight: string | undefined, hex: string): string {
    const trimmed = (flight ?? '').trim();
    return trimmed === '' ? hex : trimmed;
}

/**
 * Maps one raw v2-style aircraft entry to the shared `Aircraft` shape.
 * Returns `undefined` for entries that can't be placed on the map (no
 * position) or that report no altitude at all -- both real, sparse
 * states for a Mode-S-only contact the ADS-B feed still lists.
 */
function toAircraft(raw: RawV2Aircraft, now: Date): Aircraft | undefined {
    if (raw.lat === undefined || raw.lon === undefined) return undefined;
    if (raw.alt_baro === undefined) return undefined;

    const seenPos = raw.seen_pos ?? 0;
    const candidate = {
        icao: raw.hex,
        callsign: trimmedCallsign(raw.flight, raw.hex),
        lat: raw.lat,
        lng: raw.lon,
        altitudeFt: raw.alt_baro,
        groundSpeedKt: raw.gs ?? 0,
        track: raw.track ?? 0,
        timestamp: new Date(now.getTime() - seenPos * 1000).toISOString(),
    };

    const parsed = AircraftSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
}

function withinBbox(aircraft: Aircraft, bbox: Bbox): boolean {
    return aircraft.lat >= bbox.minLat && aircraft.lat <= bbox.maxLat && aircraft.lng >= bbox.minLng && aircraft.lng <= bbox.maxLng;
}

/**
 * Pure mapping + re-filter step for the v2 providers, exported for
 * fixture-based tests that don't need a real (or mocked) network call.
 * The v2 providers' point+radius query returns a circle, not the
 * requested rectangle -- this re-filters to the exact bbox so a corner
 * point just inside the circle but outside the rectangle isn't shown.
 */
export function mapRawV2AircraftToAircraft(rawAircraft: readonly RawV2Aircraft[], bbox: Bbox, now: Date = new Date()): Aircraft[] {
    const aircraft: Aircraft[] = [];
    for (const raw of rawAircraft) {
        const mapped = toAircraft(raw, now);
        if (mapped && withinBbox(mapped, bbox)) aircraft.push(mapped);
    }
    return aircraft;
}

async function fetchV2(provider: 'adsblol' | 'airplaneslive' | 'adsbfi', bbox: Bbox, fetchImpl: typeof fetch): Promise<Result<Aircraft[]>> {
    const { lat, lon, nm } = bboxToCenterRadius(bbox);
    const url = V2_PROVIDER_URLS[provider](lat, lon, Math.round(nm));

    let response: Response;
    try {
        response = await fetchImpl(url, { headers: { 'User-Agent': 'area-overview-bff/0.1' } });
    } catch {
        return err({ message: `ADS-B provider "${provider}" request failed (network error)` });
    }
    if (!response.ok) {
        return err({ message: `ADS-B provider "${provider}" responded with status ${String(response.status)}` });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return err({ message: `ADS-B provider "${provider}" returned a non-JSON body` });
    }

    const parsed = RawV2ResponseSchema.safeParse(body);
    if (!parsed.success) {
        return err({ message: `ADS-B provider "${provider}" response failed schema validation` });
    }

    return ok(mapRawV2AircraftToAircraft(parsed.data.ac, bbox));
}

// --- OpenSky (best-effort, see this file's doc comment) ---

const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

/**
 * One state vector, per OpenSky's documented fixed-position array shape:
 * `[icao24, callsign, origin_country, time_position, last_contact,
 * longitude, latitude, baro_altitude, on_ground, velocity, true_track,
 * vertical_rate, sensors, geo_altitude, squawk, spi, position_source]`.
 * Validated loosely (each element's *type*, not a strict tuple length)
 * since OpenSky has documented adding trailing fields over time.
 */
const OpenSkyStateSchema = z.tuple([
    z.string(), // icao24
    z.string().nullable(), // callsign
    z.string().nullable(), // origin_country
    z.number().nullable(), // time_position
    z.number().nullable(), // last_contact
    z.number().nullable(), // longitude
    z.number().nullable(), // latitude
    z.number().nullable(), // baro_altitude
    z.boolean(), // on_ground
    z.number().nullable(), // velocity
    z.number().nullable(), // true_track
    z.number().nullable(), // vertical_rate
    z.unknown(), // sensors
    z.number().nullable(), // geo_altitude
    z.string().nullable(), // squawk
    z.boolean(), // spi
    z.number().nullable(), // position_source
]);

const OpenSkyResponseSchema = z.object({
    time: z.number(),
    states: z.array(OpenSkyStateSchema).nullable(),
});

const METERS_PER_FOOT = 0.3048;

function metersToFeet(meters: number): number {
    return meters / METERS_PER_FOOT;
}

function mpsToKnots(mps: number): number {
    return mps * KNOTS_PER_MPS;
}

function openSkyStateToAircraft(state: z.infer<typeof OpenSkyStateSchema>): Aircraft | undefined {
    const [icao24, callsign, , timePosition, lastContact, longitude, latitude, baroAltitude, onGround, velocity, trueTrack, , , geoAltitude] = state;

    if (latitude === null || longitude === null) return undefined;

    const altitudeFt: Aircraft['altitudeFt'] | undefined = onGround
        ? 'ground'
        : baroAltitude !== null
          ? metersToFeet(baroAltitude)
          : geoAltitude !== null
            ? metersToFeet(geoAltitude)
            : undefined;
    if (altitudeFt === undefined) return undefined;

    const timestampSeconds = timePosition ?? lastContact;
    if (timestampSeconds === null) return undefined;

    const candidate = {
        icao: icao24,
        callsign: trimmedCallsign(callsign ?? undefined, icao24),
        lat: latitude,
        lng: longitude,
        altitudeFt,
        groundSpeedKt: velocity !== null ? mpsToKnots(velocity) : 0,
        track: trueTrack ?? 0,
        timestamp: new Date(timestampSeconds * 1000).toISOString(),
    };

    const parsed = AircraftSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
}

/** Pure mapping step for OpenSky, exported for fixture-based tests. */
export function mapOpenSkyStatesToAircraft(states: readonly z.infer<typeof OpenSkyStateSchema>[]): Aircraft[] {
    const aircraft: Aircraft[] = [];
    for (const state of states) {
        const mapped = openSkyStateToAircraft(state);
        if (mapped) aircraft.push(mapped);
    }
    return aircraft;
}

export interface OpenSkyCredentials {
    clientId: string;
    clientSecret: string;
}

async function getOpenSkyBearerToken(credentials: OpenSkyCredentials, fetchImpl: typeof fetch): Promise<Result<string>> {
    let response: Response;
    try {
        response = await fetchImpl(OPENSKY_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: credentials.clientId,
                client_secret: credentials.clientSecret,
                grant_type: 'client_credentials',
            }).toString(),
        });
    } catch {
        return err({ message: 'OpenSky token request failed (network error)' });
    }
    if (!response.ok) {
        return err({ message: `OpenSky token endpoint responded with status ${String(response.status)}` });
    }
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return err({ message: 'OpenSky token endpoint returned a non-JSON body' });
    }
    const parsed = z.object({ access_token: z.string() }).safeParse(body);
    if (!parsed.success) {
        return err({ message: 'OpenSky token endpoint response failed schema validation' });
    }
    return ok(parsed.data.access_token);
}

async function fetchOpenSky(bbox: Bbox, credentials: OpenSkyCredentials | undefined, fetchImpl: typeof fetch): Promise<Result<Aircraft[]>> {
    const params = new URLSearchParams({
        lamin: String(bbox.minLat),
        lomin: String(bbox.minLng),
        lamax: String(bbox.maxLat),
        lomax: String(bbox.maxLng),
    });

    const headers: Record<string, string> = {};
    if (credentials) {
        const tokenResult = await getOpenSkyBearerToken(credentials, fetchImpl);
        if (!tokenResult.ok) return tokenResult;
        headers.Authorization = `Bearer ${tokenResult.value}`;
    }

    let response: Response;
    try {
        response = await fetchImpl(`${OPENSKY_STATES_URL}?${params.toString()}`, { headers });
    } catch {
        return err({ message: 'OpenSky states request failed (network error)' });
    }
    if (!response.ok) {
        return err({ message: `OpenSky states endpoint responded with status ${String(response.status)}` });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return err({ message: 'OpenSky states endpoint returned a non-JSON body' });
    }

    const parsed = OpenSkyResponseSchema.safeParse(body);
    if (!parsed.success) {
        return err({ message: 'OpenSky states endpoint response failed schema validation' });
    }

    return ok(mapOpenSkyStatesToAircraft(parsed.data.states ?? []));
}

export interface FetchAircraftOptions {
    provider: AdsbProvider;
    openSkyCredentials?: OpenSkyCredentials | undefined;
    fetchImpl?: typeof fetch;
}

/** Dispatches to the configured ADS-B provider and returns aircraft mapped onto the shared `Aircraft` shape, already filtered to `bbox`. */
export async function fetchAircraft(bbox: Bbox, options: FetchAircraftOptions): Promise<Result<Aircraft[]>> {
    const fetchImpl = options.fetchImpl ?? fetch;
    if (options.provider === 'opensky') {
        return fetchOpenSky(bbox, options.openSkyCredentials, fetchImpl);
    }
    return fetchV2(options.provider, bbox, fetchImpl);
}
