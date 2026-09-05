/**
 * The single choke point through which this server talks to
 * `nesthus.no`. Every route module calls this instead of `fetch`
 * directly, so timeout handling, error normalisation and schema
 * validation only need to be right in one place.
 *
 * `path` is always a literal upstream path baked into a route module
 * (e.g. `/api/weather`), never built from request input -- this function
 * takes no `host`/`url` parameter precisely so a caller cannot smuggle an
 * arbitrary origin through it.
 */
import type { ZodType } from 'zod';
import { err, ok, type Result } from '../shared/result.js';
import type { ServerConfig } from './config.js';

const USER_AGENT = 'area-overview-bff/0.1';

export interface FetchUpstreamOptions {
    /**
     * A real HTTP 204 response has no body at all -- calling `response.json()`
     * on one throws (empty string is not valid JSON). A caller whose upstream
     * endpoint uses 204 to mean a defined "empty" state (e.g.
     * `GET /api/weather/summary` before a summary has been generated) supplies
     * the value that state parses to here, so a 204 can be validated and
     * returned directly instead of routed through JSON parsing. Left unset,
     * a 204 is validated as `null`, which is only meaningful for schemas
     * that model a bare-null empty state.
     */
    on204?: unknown;
}

export async function fetchUpstream<T>(
    path: string,
    schema: ZodType<T>,
    config: ServerConfig,
    options: FetchUpstreamOptions = {},
): Promise<Result<T>> {
    const url = new URL(path, config.upstreamBaseUrl).toString();

    let response: Response;
    try {
        response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        });
    } catch (cause) {
        return err({ message: `Upstream request to ${path} failed`, cause });
    }

    if (!response.ok) {
        return err({
            message: `Upstream ${path} responded with status ${String(response.status)}`,
            cause: response.status,
        });
    }

    if (response.status === 204) {
        const parsed = schema.safeParse(options.on204 ?? null);
        if (!parsed.success) {
            return err({ message: `Upstream ${path} response failed schema validation`, cause: parsed.error });
        }
        return ok(parsed.data);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch (cause) {
        return err({ message: `Upstream ${path} returned a non-JSON body`, cause });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        return err({ message: `Upstream ${path} response failed schema validation`, cause: parsed.error });
    }

    return ok(parsed.data);
}
