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
        cartoApiKey: env.CARTO_API_KEY,
        trailsPollSeconds: env.TRAILS_POLL_SECONDS,
        trailsAreaBbox: env.TRAILS_AREA_BBOX,
        trailsEnabled: env.TRAILS_ENABLED,
    });

    if (!parsed.success) {
        throw new Error(`Invalid server configuration: ${parsed.error.message}`);
    }

    return parsed.data;
}
