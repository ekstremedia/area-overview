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
import { AircraftSchema, type Aircraft, type AdsbSource } from '../../shared/schemas/aircraft.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Bbox } from '../layers/bbox.js';

export type AdsbProvider = AdsbSource;

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

/**
 * The three v2-style providers agree on the *aircraft* shape but not on
 * the key holding them: adsb.lol and airplanes.live use `ac`, adsb.fi
 * uses `aircraft`. Accepting either is what makes them actually
 * interchangeable -- before this, switching `ADSB_PROVIDER` to `adsbfi`
 * parsed every response as a schema failure and the layer went silently
 * empty. Both keys are optional so a provider that returns neither (an
 * empty sky, which adsb.fi expresses by omitting the key) reads as zero
 * aircraft rather than a malformed payload.
 */
const RawV2ResponseSchema = z
    .object({
        ac: z.array(RawV2AircraftSchema).optional(),
        aircraft: z.array(RawV2AircraftSchema).optional(),
    })
    .transform((body) => ({ ac: body.ac ?? body.aircraft ?? [] }));

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

async function fetchV2(
    provider: 'adsblol' | 'airplaneslive' | 'adsbfi',
    bbox: Bbox,
    upstreamTimeoutMs: number,
    fetchImpl: typeof fetch,
): Promise<Result<Aircraft[]>> {
    const { lat, lon, nm } = bboxToCenterRadius(bbox); // already an integer nm, rounded up
    const url = V2_PROVIDER_URLS[provider](lat, lon, nm);

    let response: Response;
    try {
        response = await fetchImpl(url, {
            headers: { 'User-Agent': 'area-overview-bff/0.1' },
            signal: AbortSignal.timeout(upstreamTimeoutMs),
        });
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
const OpenSkyStateSchema = z
    .tuple([
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
    ])
    .rest(z.unknown()); // tolerate trailing fields OpenSky has added since (e.g. `category`)

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

async function getOpenSkyBearerToken(credentials: OpenSkyCredentials, upstreamTimeoutMs: number, fetchImpl: typeof fetch): Promise<Result<string>> {
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
            signal: AbortSignal.timeout(upstreamTimeoutMs),
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

async function fetchOpenSky(
    bbox: Bbox,
    credentials: OpenSkyCredentials | undefined,
    upstreamTimeoutMs: number,
    fetchImpl: typeof fetch,
): Promise<Result<Aircraft[]>> {
    const params = new URLSearchParams({
        lamin: String(bbox.minLat),
        lomin: String(bbox.minLng),
        lamax: String(bbox.maxLat),
        lomax: String(bbox.maxLng),
    });

    const headers: Record<string, string> = {};
    if (credentials) {
        const tokenResult = await getOpenSkyBearerToken(credentials, upstreamTimeoutMs, fetchImpl);
        if (!tokenResult.ok) return tokenResult;
        headers.Authorization = `Bearer ${tokenResult.value}`;
    }

    let response: Response;
    try {
        response = await fetchImpl(`${OPENSKY_STATES_URL}?${params.toString()}`, { headers, signal: AbortSignal.timeout(upstreamTimeoutMs) });
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
    /** Bounded deadline for every request this call makes -- see `upstream.ts`'s `fetchUpstream()` for the same pattern. Always `config.upstreamTimeoutMs` in production. */
    upstreamTimeoutMs: number;
    fetchImpl?: typeof fetch;
}

/**
 * How long an OpenSky answer is reused before asking again, and how much
 * bigger than the caller's viewport each request is made.
 *
 * OpenSky is quota-metered (~4000 requests a day on a registered account)
 * while the ADS-B aggregators are not, and this app asks from two places
 * at once: the browser polls its viewport every 10s and the trail poller
 * sweeps a fixed area every 30s, with every pan producing another
 * rectangle. Left ungoverned that is tens of thousands of calls a day.
 *
 * So the gate is a single account-wide slot rather than a per-viewport
 * cache: the quota belongs to the account, not to whichever rectangle
 * happens to be asking, and only one shared limiter can actually hold the
 * total down. One request every 45s is ~1900 a day, comfortably inside
 * the allowance no matter how many boxes are in play.
 *
 * Each request covers the asked-for area plus `OPENSKY_MARGIN_DEGREES` on
 * every side, so an ordinary pan still lands inside what was already
 * fetched and is answered without spending another call.
 */
const OPENSKY_MIN_INTERVAL_MS = 45_000;
const OPENSKY_MARGIN_DEGREES = 0.6;

/**
 * The one OpenSky answer in hand, and the area it actually covers.
 *
 * Kept as a single slot, not a map keyed by viewport: a cached answer is
 * only usable for a request it geographically *contains*, so keying by
 * rectangle would both alias boxes together (two different viewports
 * rounding to one key) and multiply the request rate. Containment is
 * checked explicitly on every read instead.
 */
interface OpenSkySnapshot {
    /** The area actually queried -- a cached answer is only valid for requests inside this. */
    bbox: Bbox;
    aircraft: Aircraft[];
    fetchedAtMs: number;
}

let openSkySnapshot: OpenSkySnapshot | null = null;
let openSkyLastRequestMs = 0;
/** Single-flight: two callers arriving together share one request rather than spending two of the quota. */
let openSkyInFlight: Promise<OpenSkySnapshot | null> | null = null;

/** Test-only reset, so one test's snapshot and gate can never leak into the next. */
export function __resetOpenSkyStateForTests(): void {
    openSkySnapshot = null;
    openSkyLastRequestMs = 0;
    openSkyInFlight = null;
}

function containsBbox(outer: Bbox, inner: Bbox): boolean {
    return outer.minLat <= inner.minLat && outer.minLng <= inner.minLng && outer.maxLat >= inner.maxLat && outer.maxLng >= inner.maxLng;
}

/** Clamped to real coordinates, since a margin near the poles or the antimeridian would otherwise produce a box OpenSky rejects. */
function withMargin(bbox: Bbox): Bbox {
    return {
        minLat: Math.max(-90, bbox.minLat - OPENSKY_MARGIN_DEGREES),
        maxLat: Math.min(90, bbox.maxLat + OPENSKY_MARGIN_DEGREES),
        minLng: Math.max(-180, bbox.minLng - OPENSKY_MARGIN_DEGREES),
        maxLng: Math.min(180, bbox.maxLng + OPENSKY_MARGIN_DEGREES),
    };
}

/** A snapshot covers a wider area than the caller asked about, so what it hands back is always narrowed to the requested rectangle. */
function aircraftWithin(aircraft: readonly Aircraft[], bbox: Bbox): Aircraft[] {
    return aircraft.filter((one) => one.lat >= bbox.minLat && one.lat <= bbox.maxLat && one.lng >= bbox.minLng && one.lng <= bbox.maxLng);
}

/**
 * The OpenSky aircraft inside `bbox`, refreshing at most once per
 * `OPENSKY_MIN_INTERVAL_MS` across the whole process.
 *
 * Returns whatever it can: a fresh answer, a stale one that still covers
 * the area, or `null`. It never throws and never reports failure upward --
 * this is a second opinion, and the caller's primary result must survive
 * OpenSky being down, throttled or simply not yet asked.
 */
async function openSkyAircraftWithin(
    bbox: Bbox,
    credentials: OpenSkyCredentials,
    upstreamTimeoutMs: number,
    fetchImpl: typeof fetch,
    nowMs: number,
): Promise<Aircraft[] | null> {
    const usable = openSkySnapshot && containsBbox(openSkySnapshot.bbox, bbox) ? openSkySnapshot : null;
    const fresh = usable !== null && nowMs - usable.fetchedAtMs < OPENSKY_MIN_INTERVAL_MS;
    if (fresh) return aircraftWithin(usable.aircraft, bbox);

    // The gate is checked against the last *request*, not the last
    // success: a failing OpenSky must not be retried every 10s.
    const gateOpen = nowMs - openSkyLastRequestMs >= OPENSKY_MIN_INTERVAL_MS;
    if (!gateOpen) {
        // Stale but covering the area beats nothing while the gate is shut.
        return usable ? aircraftWithin(usable.aircraft, bbox) : null;
    }

    openSkyLastRequestMs = nowMs;
    const query = withMargin(bbox);
    openSkyInFlight ??= (async (): Promise<OpenSkySnapshot | null> => {
        const result = await fetchOpenSky(query, credentials, upstreamTimeoutMs, fetchImpl);
        if (!result.ok) return null;
        return { bbox: query, aircraft: result.value, fetchedAtMs: nowMs };
    })();

    let snapshot: OpenSkySnapshot | null;
    try {
        snapshot = await openSkyInFlight;
    } catch {
        snapshot = null;
    } finally {
        openSkyInFlight = null;
    }

    if (snapshot) {
        openSkySnapshot = snapshot;
        return aircraftWithin(snapshot.aircraft, bbox);
    }
    // The refresh failed: fall back to the stale answer if it still covers
    // the area, which is exactly the case the caller needs when its own
    // primary provider has failed too.
    return usable ? aircraftWithin(usable.aircraft, bbox) : null;
}

/**
 * Merges a secondary source into the primary's results, keyed by ICAO
 * address. Where both networks have an aircraft the fresher fix wins;
 * where only one does, it is added.
 *
 * This exists because the networks genuinely differ: measured over
 * Sortland, adsb.fi and adsb.lol both had only a single airliner 45km
 * away while OpenSky had a Widerøe flight at 9,500ft directly overhead.
 * Neither is a superset of the other, so the union is the only honest
 * answer to "what is up there".
 *
 * `secondaryContributed` says whether any of the returned aircraft came
 * from the secondary network, which is what the footer's credit line
 * turns on: a secondary that answered, but whose every aircraft lost to
 * a fresher primary fix, contributed nothing to what is on screen and
 * must not be named as a source of it.
 */
export function mergeAircraft(primary: readonly Aircraft[], secondary: readonly Aircraft[]): { aircraft: Aircraft[]; secondaryContributed: boolean } {
    const byIcao = new Map<string, { aircraft: Aircraft; fromSecondary: boolean }>();
    for (const [index, aircraft] of [...primary, ...secondary].entries()) {
        const fromSecondary = index >= primary.length;
        const existing = byIcao.get(aircraft.icao);
        if (!existing || Date.parse(aircraft.timestamp) > Date.parse(existing.aircraft.timestamp)) {
            byIcao.set(aircraft.icao, { aircraft, fromSecondary });
        }
    }
    const entries = [...byIcao.values()];
    return {
        aircraft: entries.map((entry) => entry.aircraft),
        secondaryContributed: entries.some((entry) => entry.fromSecondary),
    };
}

export interface FetchAircraftResult {
    aircraft: Aircraft[];
    /**
     * The provider(s) whose data is actually present in `aircraft` --
     * used for the map footer's attribution credit. `options.provider` is
     * only ever a *configuration* ("what to ask"); this is the answer to
     * "what actually answered", which is what the credit must name. In
     * particular `'opensky'` is included only when its own fetch (fresh
     * or a still-covering stale snapshot) produced at least one aircraft
     * that fed into the result -- not merely because credentials are set.
     */
    sources: AdsbSource[];
}

/** Dispatches to the configured ADS-B provider and returns aircraft mapped onto the shared `Aircraft` shape, already filtered to `bbox`. */
export async function fetchAircraft(bbox: Bbox, options: FetchAircraftOptions): Promise<Result<FetchAircraftResult>> {
    const fetchImpl = options.fetchImpl ?? fetch;
    if (options.provider === 'opensky') {
        const result = await fetchOpenSky(bbox, options.openSkyCredentials, options.upstreamTimeoutMs, fetchImpl);
        return result.ok ? ok({ aircraft: result.value, sources: ['opensky'] }) : result;
    }

    const primary = await fetchV2(options.provider, bbox, options.upstreamTimeoutMs, fetchImpl);

    // OpenSky only augments when credentials are configured: anonymous
    // access is capped near 400 requests a day, far too little to be worth
    // spending on a second opinion.
    const credentials = options.openSkyCredentials;
    if (!credentials) return primary.ok ? ok({ aircraft: primary.value, sources: [options.provider] }) : primary;

    const secondary = await openSkyAircraftWithin(bbox, credentials, options.upstreamTimeoutMs, fetchImpl, Date.now());

    if (!primary.ok) {
        // The primary is down. Anything OpenSky has -- including a stale
        // snapshot -- beats failing the request outright.
        return secondary && secondary.length > 0 ? ok({ aircraft: secondary, sources: ['opensky'] }) : primary;
    }

    // Not "OpenSky answered" but "OpenSky is in the answer": every one of
    // its aircraft can lose the merge to a fresher primary fix, in which
    // case nothing on screen came from it.
    const merged = secondary ? mergeAircraft(primary.value, secondary) : { aircraft: primary.value, secondaryContributed: false };
    const sources: AdsbSource[] = merged.secondaryContributed ? [options.provider, 'opensky'] : [options.provider];
    return ok({ aircraft: merged.aircraft, sources });
}
