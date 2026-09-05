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

export async function fetchUpstream<T>(path: string, schema: ZodType<T>, config: ServerConfig): Promise<Result<T>> {
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
