/**
 * Keeps the trail stores fed while nobody is asking.
 *
 * Without this, history would only accumulate for whatever viewport a
 * browser happened to be polling, and only while it was on the map page.
 * The kiosk spends most of its time elsewhere -- other pages, the
 * auto-cycle, a dark screen overnight -- so a trail would be empty
 * exactly when someone walks up and looks. Polling one fixed area on the
 * server instead means the history is already there.
 *
 * The poller never throws and never lets a failure end the schedule: an
 * upstream being down is an ordinary condition here (BarentsWatch tokens
 * expire, adsb.lol rate-limits, the kiosk's Wi-Fi drops), and the right
 * response is to keep the previous history and try again on the next
 * tick. What it must never do is take the server down with it, or clear
 * what it already knows because one fetch failed.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Result } from '../../shared/result.js';

export interface TrailPollerSource {
    /** Named in logs, so a failing upstream is identifiable without reading code. */
    name: string;
    /**
     * Fetches this source's area and folds the result into its own store.
     * Returns a `Result` rather than throwing, and owns both halves so the
     * poller stays free of any per-source types -- ships and aircraft have
     * nothing in common here beyond "went wrong" or "didn't".
     */
    poll: (now: Date) => Promise<Result<void>>;
}

export interface StartTrailPollerOptions {
    intervalMs: number;
    logger: FastifyBaseLogger;
    /** Injected by tests; production uses the real clock. */
    now?: () => Date;
}

/**
 * Polls every source on `intervalMs`, starting with one immediate round
 * so a fresh boot has something to serve before the first interval
 * elapses. Returns a stop function; call it on server close.
 */
export function startTrailPoller(sources: readonly TrailPollerSource[], options: StartTrailPollerOptions): () => void {
    const now = options.now ?? ((): Date => new Date());
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function pollOne(source: TrailPollerSource): Promise<void> {
        try {
            const result = await source.poll(now());
            if (stopped) return; // shutting down; whatever arrived is no longer wanted
            if (!result.ok) {
                // Expected, not exceptional: keep the existing history and
                // let the next tick try again.
                options.logger.warn({ source: source.name, reason: result.error.message }, 'trail poll failed; keeping previous history');
            }
        } catch (error) {
            // A source that throws rather than returning an error result is
            // a bug in that source, but it must still not kill the schedule
            // or the process (an unhandled rejection in a timer would).
            options.logger.error({ source: source.name, err: error }, 'trail poll threw; keeping previous history');
        }
    }

    function pollAll(): void {
        // Sources are independent: one upstream being down must not delay
        // or skip the other's poll.
        for (const source of sources) void pollOne(source);
    }

    pollAll();
    timer = setInterval(pollAll, options.intervalMs);
    // Never hold the process open on this alone -- a poll timer must not
    // be what keeps a shutting-down server alive.
    timer.unref();

    return function stop(): void {
        stopped = true;
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };
}
