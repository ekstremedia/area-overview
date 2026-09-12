/**
 * One nationwide AIS snapshot, shared by every caller that wants ships.
 *
 * BarentsWatch's `GET /v1/latest/combined` has no bbox parameter -- it
 * returns the whole country or nothing (see `barentswatch.ts`'s doc
 * comment for why the filtered endpoint is unusable here). That was
 * affordable while this app had one viewer: `GET /api/ships` cached per
 * bbox, so one kiosk meant one nationwide download per cache TTL.
 *
 * On the public internet it stops being affordable, because the *cache*
 * is keyed per bbox while the *fetch* is nationwide: fifty visitors
 * looking at fifty different places cost fifty full-country downloads per
 * TTL, all of them returning substantially the same multi-megabyte body.
 * This module moves the expensive part behind a single process-wide slot,
 * so the upstream cost is one fetch per `refreshMs` no matter how many
 * viewports ask, and serving a new viewport costs a `shipsWithin` filter.
 *
 * Three behaviours callers depend on:
 *
 * - **Single-flight.** Concurrent callers arriving during a fetch share
 *   that one promise rather than each starting their own.
 * - **Gated on the last *attempt*, not the last success.** A failing
 *   BarentsWatch is retried once per `refreshMs`, not once per request --
 *   otherwise an outage turns every visitor's poll into its own retry and
 *   the app hammers an upstream that is already struggling.
 * - **The previous snapshot outlives a failed refresh, but not for
 *   ever.** A refresh that fails while a recent snapshot is held resolves
 *   `ok` with the old ships: vessels carry their own fix timestamps and
 *   the map fades stale ones itself, so slightly old ships beat an empty
 *   sea. Past `maxStaleMs` the error surfaces instead, which is what lets
 *   `GET /api/ships` fall through to the remembered-vessels path in the
 *   trail store rather than presenting hours-old positions as current.
 */
import type { Ship } from '../../shared/schemas/ships.js';
import { err, ok, type Result } from '../../shared/result.js';
import { fetchAllShips } from './barentswatch.js';
import type { BarentsWatchToken } from './token.js';

export interface ShipsSnapshot {
    /**
     * Every ship BarentsWatch currently knows about, nationwide. Filter
     * with `shipsWithin` for a viewport -- do not call `fetchAllShips`
     * directly. `nowMs` is injectable so tests can drive the refresh gate
     * without fake timers.
     */
    ships(nowMs?: number): Promise<Result<readonly Ship[]>>;
}

export interface ShipsSnapshotOptions {
    upstreamTimeoutMs: number;
    /** Minimum spacing between upstream fetches, measured from the start of the last attempt. */
    refreshMs: number;
    /** How old a held snapshot may get before a failed refresh surfaces the error instead of serving it. Defaults to `DEFAULT_MAX_STALE_MS`. */
    maxStaleMs?: number;
    fetchImpl?: typeof fetch;
}

/**
 * Ten minutes. Long enough that a brief BarentsWatch hiccup is invisible
 * to everyone watching the map, short enough that a real outage stops
 * being dressed up as live traffic: the trail store remembers vessels for
 * an hour, so past this point the route has something honestly labelled
 * to fall back to.
 */
export const DEFAULT_MAX_STALE_MS = 10 * 60_000;

/**
 * State lives in the returned closure rather than at module scope, so
 * every `buildApp` gets its own slot -- two Fastify instances in one test
 * run must not share a snapshot, and a test must not have to reset module
 * state it never created.
 */
export function createShipsSnapshot(token: BarentsWatchToken, options: ShipsSnapshotOptions): ShipsSnapshot {
    const { upstreamTimeoutMs, refreshMs, fetchImpl } = options;
    const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;

    let snapshot: readonly Ship[] | undefined;
    let snapshotAt = Number.NEGATIVE_INFINITY;
    let lastFailure: { message: string } | undefined;
    let lastAttemptAt = Number.NEGATIVE_INFINITY;
    let inflight: Promise<Result<readonly Ship[]>> | undefined;

    /** A held snapshot young enough to still pass for current traffic. */
    function servableSnapshot(nowMs: number): readonly Ship[] | undefined {
        if (!snapshot) return undefined;
        return nowMs - snapshotAt <= maxStaleMs ? snapshot : undefined;
    }

    async function refresh(nowMs: number): Promise<Result<readonly Ship[]>> {
        const result = await fetchAllShips(token, upstreamTimeoutMs, fetchImpl);

        if (result.ok) {
            snapshot = result.value;
            snapshotAt = nowMs;
            lastFailure = undefined;
            return result;
        }

        lastFailure = result.error;
        // A recent snapshot outlives the failure that would otherwise
        // replace it with an error -- see this file's doc comment.
        const servable = servableSnapshot(nowMs);
        return servable ? ok(servable) : result;
    }

    async function ships(nowMs: number = Date.now()): Promise<Result<readonly Ship[]>> {
        // Checked before the gate: a caller arriving mid-fetch should wait
        // for that fetch rather than be handed the older snapshot it is
        // already in the process of replacing.
        if (inflight) return inflight;

        if (nowMs - lastAttemptAt < refreshMs) {
            const servable = servableSnapshot(nowMs);
            if (servable) return ok(servable);
            if (lastFailure) return err(lastFailure);
        }

        // Stamped before the await, so the next caller inside the window is
        // gated whether this attempt succeeds or fails.
        lastAttemptAt = nowMs;
        const load = refresh(nowMs).finally(() => {
            inflight = undefined;
        });
        inflight = load;
        return load;
    }

    return { ships };
}
