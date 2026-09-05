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
    upstreamBaseUrl: z.string().min(1).default('https://nesthus.no'),
    upstreamTimeoutMs: z.coerce.number().int().positive().default(8000),
    cacheTtlMs: z.coerce.number().int().positive().default(30000),
    pointForecastTtlMs: z.coerce.number().int().positive().default(60000),
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
     * same pattern as `cacheTtlMs`/`pointForecastTtlMs`.
     */
    shipsCacheTtlMs: z.coerce.number().int().positive().default(10_000),
    aircraftCacheTtlMs: z.coerce.number().int().positive().default(10_000),
    /** Optional OpenSky OAuth2 client-credentials pair, for the registered tier's higher anonymous-quota-free rate limit. Never logged. */
    openskyClientId: z.string().default(''),
    openskyClientSecret: z.string().default(''),
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
        pointForecastTtlMs: env.POINT_FORECAST_TTL_MS,
        settingsPassword: env.SETTINGS_PASSWORD,
        settingsFile: env.SETTINGS_FILE,
        barentswatchClientId: env.BARENTSWATCH_CLIENT_ID,
        barentswatchClientSecret: env.BARENTSWATCH_CLIENT_SECRET,
        adsbProvider: env.ADSB_PROVIDER,
        openskyClientId: env.OPENSKY_CLIENT_ID,
        openskyClientSecret: env.OPENSKY_CLIENT_SECRET,
        shipsCacheTtlMs: env.SHIPS_CACHE_TTL_MS,
        aircraftCacheTtlMs: env.AIRCRAFT_CACHE_TTL_MS,
    });

    if (!parsed.success) {
        throw new Error(`Invalid server configuration: ${parsed.error.message}`);
    }

    return parsed.data;
}
