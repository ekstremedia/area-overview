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
    });

    if (!parsed.success) {
        throw new Error(`Invalid server configuration: ${parsed.error.message}`);
    }

    return parsed.data;
}
