/**
 * Server configuration is parsed from `process.env` through a Zod schema so
 * a missing or malformed environment variable fails loudly at boot -- never
 * silently falls back to a default that masks a deployment mistake for
 * variables that *are* set but set wrong (e.g. `PORT=abc`).
 *
 * This schema is intentionally separate from `src/shared/schemas/*`: it
 * describes this server's own process environment, not an upstream API
 * contract, and has no reason to be shared with the frontend bundle.
 */
import { z } from 'zod';

const ServerConfigSchema = z.object({
    port: z.coerce.number().int().positive().default(8141),
    host: z.string().min(1).default('127.0.0.1'),
    upstreamBaseUrl: z.url().default('https://nesthus.no'),
    upstreamTimeoutMs: z.coerce.number().int().positive().default(8000),
    cacheTtlMs: z.coerce.number().int().positive().default(30000),
    /**
     * No default -- deliberately. The settings store is the only write
     * surface in this app and it will end up reachable from the public
     * internet with no auth in front of it besides this password, so a
     * missing/short value must fail boot loudly rather than silently run
     * with a guessable or empty password. `.min(16)` is enforced here (not
     * just documented) so a too-short value fails the same way a missing
     * one does. The Zod issue message never includes the attempted value.
     */
    settingsPassword: z.string().min(16, 'SETTINGS_PASSWORD must be set and at least 16 characters long'),
    settingsFile: z.string().min(1).default('data/settings.json'),
    /**
     * BarentsWatch AIS credentials -- optional, unlike `settingsPassword`.
     * Empty is a fully valid, expected running state: `GET /api/ships`
     * reports `{configured:false}` rather than the server refusing to
     * boot. Never logged, never included in an error message or thrown
     * exception -- see `src/server/ships/token.ts` and `barentswatch.ts`.
     */
    barentswatchClientId: z.string().default(''),
    barentswatchClientSecret: z.string().default(''),
    /** Selects the keyless ADS-B aggregator `src/server/aircraft/provider.ts` queries. Aircraft need no credentials to be "configured" for any provider but `opensky`. */
    adsbProvider: z.enum(['adsblol', 'airplaneslive', 'adsbfi', 'opensky']).default('adsblol'),
    /**
     * `GET /api/ships`/`GET /api/aircraft` cache TTL, keyed per-bbox
     * rather than the single fixed key `cacheTtlMs` is used for. The
     * plan requires >= 10s in production (both default here); tests
     * shrink these to exercise the stale-while-revalidate path quickly,
     */
    shipsCacheTtlMs: z.coerce.number().int().positive().default(10_000),
    aircraftCacheTtlMs: z.coerce.number().int().positive().default(10_000),
    /**
     * Minimum spacing between nationwide BarentsWatch fetches, for the
     * one snapshot every viewport is filtered out of
     * (`src/server/ships/snapshot.ts`). Deliberately a separate knob from
     * `shipsCacheTtlMs`, which still means what it always did -- how long
     * one viewport's trail-decorated response stays fresh. This one
     * governs the multi-megabyte upstream download those responses are
     * built from, so raising it trades vessel freshness for upstream
     * load, and lowering it does the reverse for every visitor at once.
     */
    shipsSnapshotRefreshMs: z.coerce.number().int().positive().default(10_000),
    /**
     * How old the held AIS snapshot may get, while BarentsWatch is
     * unreachable, before `GET /api/ships` stops serving it and falls
     * through to this viewport's stale cache and then to the trail
     * store's remembered vessels. In other words: the longest this app
     * will present positions it fetched earlier as current traffic.
     * Zero is meaningful and is what the tests use -- it disables serving
     * a held snapshot through a failure entirely.
     */
    shipsSnapshotMaxStaleMs: z.coerce
        .number()
        .int()
        .nonnegative()
        .default(10 * 60_000),
    /**
     * The process-wide ADS-B outbound budget: one request per
     * `ADSB_MIN_INTERVAL_MS` on average, with up to `ADSB_BURST` banked
     * for the flurry of `moveend`s a real pan produces. This bounds what
     * this app sends to adsb.lol / airplanes.live / adsb.fi no matter how
     * many visitors are polling -- they are free community services with
     * no key and no quota to push back with. Raising the interval is the
     * polite direction; see `src/server/outbound-gate.ts`.
     */
    adsbMinIntervalMs: z.coerce.number().int().positive().default(2000),
    adsbBurst: z.coerce.number().int().positive().default(4),
    /**
     * `GET /api/road-situations` / `GET /api/road-cameras` cache TTLs,
     * keyed per-bbox like the ships/aircraft ones above.
     *
     * They differ by a factor of 2.5 because they answer differently
     * changing questions: a road may close at any moment, while the
     * camera roster is 890 fixed installations that barely move. The
     * picture itself is not cached here at all -- the browser fetches
     * each still straight from Vegvesen.
     */
    roadSituationsCacheTtlMs: z.coerce.number().int().positive().default(120_000),
    roadCamerasCacheTtlMs: z.coerce.number().int().positive().default(300_000),
    /**
     * The process-wide Statens vegvesen outbound budget, shared by both
     * road routes: one request per `VEGVESEN_MIN_INTERVAL_MS` on average,
     * with up to `VEGVESEN_BURST` banked for the flurry of `moveend`s a
     * real pan produces. Same arrangement, and same reasoning, as the
     * ADS-B gate above -- the OGC GeoServer is keyless, has no quota to
     * push back with and no SLA, so the politeness has to be ours. One
     * gate rather than two, so the two routes cannot each spend a full
     * budget at the same moment.
     */
    vegvesenMinIntervalMs: z.coerce.number().int().positive().default(500),
    vegvesenBurst: z.coerce.number().int().positive().default(6),
    /**
     * How long a point forecast (`/api/weather?lat&lng`,
     * `/api/tide?lat&lng`) is held.
     *
     * Much longer than `cacheTtlMs`, because it answers a different
     * question. The home position is a live display refreshed every thirty
     * seconds; a visitor's point forecast does not change by the
     * half-minute, and every distinct coordinate is its own upstream call.
     * Ten minutes also matches what the upstream caches a point forecast
     * for, so a shorter value here would buy nothing but traffic.
     */
    pointForecastTtlMs: z.coerce.number().int().positive().default(600_000),
    /** Optional OpenSky OAuth2 client-credentials pair, for the registered tier's higher anonymous-quota-free rate limit. Never logged. */
    openskyClientId: z.string().default(''),
    openskyClientSecret: z.string().default(''),
    /**
     * CARTO basemap API key -- optional, like the BarentsWatch credentials
     * above. Empty is a fully valid, expected running state: the map's
     * dark theme still boots, its tiles just come back watermarked
     * "API key required" by CARTO rather than failing to load (see
     * `src/server/routes/map-config.ts` and `src/web/pages/map/tiles.ts`).
     * This key is meant to be public/client-visible (like a Mapbox public
     * token), unlike BarentsWatch's server-only secret, so it is exposed
     * to the frontend as-is rather than used to sign a server-side request.
     */
    cartoApiKey: z.string().default(''),
    /**
     * How often the BFF polls its fixed area of interest to keep vessel
     * trails accumulating while nobody is watching the map (see
     * `src/server/trails/poller.ts`). Slower than a browser's own poll
     * on purpose: this runs forever, and a trail wants enough points to
     * read as a line, not a fresh fix every few seconds.
     */
    trailsPollSeconds: z.coerce.number().int().min(10).max(600).default(30),
    /**
     * The area polled for trails, as `minLng,minLat,maxLng,maxLat` --
     * the same ordering `?bbox=` uses. Defaults to Vesterålen around
     * Sortland, generous enough to cover any viewport the kiosk is
     * likely to be panned to. Set `TRAILS_AREA_BBOX` to widen or move it.
     *
     * Sized to sit exactly at `clampBbox`'s 2-degree limit rather than
     * over it: a default that gets silently shrunk on the way in is a
     * default that lies about what is polled.
     */
    trailsAreaBbox: z.string().default('14.5,68.35,16.5,69.05'),
    /** Set `TRAILS_ENABLED=false` to run without the background poller at all -- trails then only accumulate from whatever a browser is actively polling. */
    trailsEnabled: z
        .enum(['true', 'false'])
        .default('true')
        .transform((value) => value === 'true'),
    /** Identifies this app to Entur's realtime API via the `ET-Client-Name` header -- Entur's own convention in place of a credential; the feed is otherwise keyless. */
    enturClientName: z.string().min(1).default('nesthus-area-overview'),
    /** `GET /api/transit` cache TTL, keyed per-bbox like ships/aircraft/roads above. */
    transitCacheTtlMs: z.coerce.number().int().positive().default(10_000),
    /**
     * The process-wide Entur outbound budget: one request per
     * `ENTUR_MIN_INTERVAL_MS` on average, with up to `ENTUR_BURST` banked
     * for the flurry of `moveend`s a real pan produces. Same arrangement,
     * and same reasoning, as the ADS-B and Vegvesen gates above -- the
     * realtime vehicles API is keyless, has no published quota and no
     * SLA, so the politeness has to be ours.
     */
    enturMinIntervalMs: z.coerce.number().int().positive().default(5000),
    enturBurst: z.coerce.number().int().positive().default(3),
    /** `GET /api/warnings`'s MET Alerts half -- cache TTL, keyed per-bbox. Warnings change far slower than a position fix, hence the much longer default than the other layers. */
    metAlertsCacheTtlMs: z.coerce.number().int().positive().default(300_000),
    /**
     * MET Norway's API terms of use require every caller to identify
     * itself with a descriptive `User-Agent` including contact
     * information -- not a secret, so it lives in `.env.example` and this
     * default rather than a real `.env`.
     */
    metUserAgent: z.string().min(1).default('area-overview-bff/0.1 (+https://area.nesthus.no; terjen@gmail.com)'),
    /**
     * The process-wide MET Alerts outbound budget: one request per
     * `MET_MIN_INTERVAL_MS` on average, with up to `MET_BURST` banked for
     * the flurry of `moveend`s a real pan produces. Same arrangement, and
     * same reasoning, as the ADS-B/Vegvesen/Entur gates above -- MET
     * Alerts is keyless and free, with no quota to push back with, so
     * raising the interval is the polite direction. Longer than those
     * gates' intervals because one call fetches the whole of Norway
     * rather than one viewport, so it is worth spacing out further.
     */
    metMinIntervalMs: z.coerce.number().int().positive().default(20_000),
    metBurst: z.coerce.number().int().positive().default(2),
    /** `GET /api/warnings`'s NVE Varsom avalanche half -- cache TTL for a region's danger level, which NVE itself updates at most a few times a day. */
    avalancheCacheTtlMs: z.coerce.number().int().positive().default(1_800_000),
    /** NVE Varsom's forecast region roster -- geometry that essentially never changes, so it is cached far longer than the danger levels themselves. */
    avalancheRegionsCacheTtlMs: z.coerce.number().int().positive().default(86_400_000),
    /**
     * The process-wide NVE Varsom outbound budget, shared by the region
     * roster fetch and every per-region warning fetch: one request per
     * `NVE_MIN_INTERVAL_MS` on average, with up to `NVE_BURST` banked for
     * a viewport that touches several regions at once. Same reasoning as
     * the other keyless-upstream gates above.
     */
    nveMinIntervalMs: z.coerce.number().int().positive().default(60_000),
    nveBurst: z.coerce.number().int().positive().default(2),
    /** `GET /api/species` cache TTL, keyed per-bbox and per `settings.species.days` window. GBIF's occurrence index is itself a slow-moving snapshot, hence the long default. */
    speciesCacheTtlMs: z.coerce.number().int().positive().default(1_800_000),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Reads the relevant `process.env` entries and validates them. Throws
 * (deliberately -- this is a boot-time failure, not a `Result`-worthy
 * runtime one) when a set variable doesn't parse.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const parsed = ServerConfigSchema.safeParse({
        port: env.PORT,
        host: env.HOST,
        upstreamBaseUrl: env.UPSTREAM_BASE_URL,
        upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
        cacheTtlMs: env.CACHE_TTL_MS,
        settingsPassword: env.SETTINGS_PASSWORD,
        settingsFile: env.SETTINGS_FILE,
        barentswatchClientId: env.BARENTSWATCH_CLIENT_ID,
        barentswatchClientSecret: env.BARENTSWATCH_CLIENT_SECRET,
        adsbProvider: env.ADSB_PROVIDER,
        openskyClientId: env.OPENSKY_CLIENT_ID,
        openskyClientSecret: env.OPENSKY_CLIENT_SECRET,
        shipsCacheTtlMs: env.SHIPS_CACHE_TTL_MS,
        aircraftCacheTtlMs: env.AIRCRAFT_CACHE_TTL_MS,
        shipsSnapshotRefreshMs: env.SHIPS_SNAPSHOT_REFRESH_MS,
        shipsSnapshotMaxStaleMs: env.SHIPS_SNAPSHOT_MAX_STALE_MS,
        pointForecastTtlMs: env.POINT_FORECAST_TTL_MS,
        adsbMinIntervalMs: env.ADSB_MIN_INTERVAL_MS,
        adsbBurst: env.ADSB_BURST,
        roadSituationsCacheTtlMs: env.ROAD_SITUATIONS_CACHE_TTL_MS,
        roadCamerasCacheTtlMs: env.ROAD_CAMERAS_CACHE_TTL_MS,
        vegvesenMinIntervalMs: env.VEGVESEN_MIN_INTERVAL_MS,
        vegvesenBurst: env.VEGVESEN_BURST,
        cartoApiKey: env.CARTO_API_KEY,
        trailsPollSeconds: env.TRAILS_POLL_SECONDS,
        trailsAreaBbox: env.TRAILS_AREA_BBOX,
        trailsEnabled: env.TRAILS_ENABLED,
        enturClientName: env.ENTUR_CLIENT_NAME,
        transitCacheTtlMs: env.TRANSIT_CACHE_TTL_MS,
        enturMinIntervalMs: env.ENTUR_MIN_INTERVAL_MS,
        enturBurst: env.ENTUR_BURST,
        metAlertsCacheTtlMs: env.MET_ALERTS_CACHE_TTL_MS,
        metUserAgent: env.MET_USER_AGENT,
        metMinIntervalMs: env.MET_MIN_INTERVAL_MS,
        metBurst: env.MET_BURST,
        avalancheCacheTtlMs: env.AVALANCHE_CACHE_TTL_MS,
        avalancheRegionsCacheTtlMs: env.AVALANCHE_REGIONS_CACHE_TTL_MS,
        nveMinIntervalMs: env.NVE_MIN_INTERVAL_MS,
        nveBurst: env.NVE_BURST,
        speciesCacheTtlMs: env.SPECIES_CACHE_TTL_MS,
    });

    if (!parsed.success) {
        throw new Error(`Invalid server configuration: ${parsed.error.message}`);
    }

    return parsed.data;
}
