/**
 * `resource` wraps a polling fetch in a `Signal`-like read of a
 * discriminated `ResourceState`, so a page can render `idle` / `loading`
 * / `ready` / `error` without ever touching a bare `Promise`.
 *
 * Two behaviours exist specifically because this runs on a kiosk display
 * left on for weeks: polling pauses while the tab is hidden (no point
 * hammering the BFF nobody is looking at), and resumes with an immediate
 * refetch -- not a resumed timer -- so the display is never stale for up
 * to a full `intervalMs` after being looked at again.
 */
import type { Result } from '../../shared/result.js';
import { signal, type ReadonlySignal } from './signal.js';

export type ResourceState<T> =
    { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: T; fetchedAt: Date } | { status: 'error'; error: Error; lastData?: T };

export interface Resource<T> {
    state: ReadonlySignal<ResourceState<T>>;
    /**
     * Fetches now, outside the poll rhythm, for a caller that knows the
     * answer just went stale -- the map layers use it when the viewport
     * moves, since their fetch is parameterised by the visible bbox and
     * waiting out the rest of the interval would leave the newly-revealed
     * area empty. Restarts the interval (when one is running) so the next
     * poll is a full interval after this fetch rather than landing right
     * on its heels.
     */
    refresh(): void;
    dispose(): void;
}

export interface ResourceOptions {
    intervalMs: number;
    /**
     * Ceiling for the exponential backoff applied after consecutive
     * failures. Defaults to `DEFAULT_MAX_BACKOFF_FACTOR` times
     * `intervalMs`.
     *
     * This matters because the app is public now: when the BFF or an
     * upstream is down, every open tab is otherwise a client retrying on
     * its own fixed rhythm for as long as the page stays open, and the
     * failing service gets the *most* traffic exactly when it can least
     * take it. Backing off spreads them out; a single success snaps the
     * interval straight back, so recovery is not itself delayed.
     */
    maxBackoffMs?: number;
}

/** Five failed polls in a row take a 30s interval to its 5-minute ceiling. */
const DEFAULT_MAX_BACKOFF_FACTOR = 10;

export function resource<T>(fetcher: () => Promise<Result<T>>, options: ResourceOptions): Resource<T> {
    const state = signal<ResourceState<T>>({ status: 'idle' });
    let lastData: T | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
    // Incremented at the start of every `load()` call so a slower, older call can
    // detect it has been superseded by a newer one before publishing its result.
    let generation = 0;
    // Consecutive failures, reset by the first success. Drives the poll
    // interval through `currentIntervalMs()`.
    let failures = 0;
    // Read through a function, not the bare `disposed` variable, at every check below: `disposed`
    // can flip to `true` from `dispose()` while a `load()` call is suspended on `await fetcher()`,
    // and TS's control-flow narrowing can't see that closure-based mutation -- reading it directly
    // makes the compiler (wrongly) treat a later re-check as dead code.
    function isDisposed(): boolean {
        return disposed;
    }

    function stopInterval(): void {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    }

    /**
     * `intervalMs` doubled per consecutive failure, capped. Deliberately
     * not jittered: this app's clients are a handful of browsers, not a
     * fleet, so the thundering-herd problem jitter solves does not arise,
     * and a predictable interval is far easier to reason about from a log.
     */
    function currentIntervalMs(): number {
        if (failures === 0) return options.intervalMs;
        // Clamped to at least `intervalMs`: a caller passing zero, a
        // negative, or a non-finite ceiling would otherwise make a failing
        // resource poll *faster* than a healthy one -- the exact opposite
        // of what a backoff is for, and a `setInterval(0)` at worst.
        const requested = options.maxBackoffMs;
        const ceiling =
            requested !== undefined && Number.isFinite(requested)
                ? Math.max(options.intervalMs, requested)
                : options.intervalMs * DEFAULT_MAX_BACKOFF_FACTOR;
        return Math.min(ceiling, options.intervalMs * 2 ** failures);
    }

    function startInterval(): void {
        stopInterval();
        timer = setInterval(() => void load(), currentIntervalMs());
    }

    /** Re-arms the timer at the new interval, but only if one is already running -- a hidden tab must stay stopped. */
    function restartIntervalIfRunning(): void {
        if (timer !== undefined) startInterval();
    }

    async function load(): Promise<void> {
        if (isDisposed()) return;
        // Only the first load may show `loading`. A refresh poll keeps the current
        // `ready`/`error` state on screen while it fetches, so consumers never flap
        // back to defaults between polls.
        if (lastData === undefined) state.set({ status: 'loading' });
        // Guard against out-of-order resolution: if a later `load()` call has already
        // started (and possibly already resolved) by the time this call resolves,
        // this call's result is stale and must be discarded entirely, even from
        // `lastData`.
        generation += 1;
        const thisGeneration = generation;
        try {
            const result = await fetcher();
            if (isDisposed() || thisGeneration !== generation) return;
            if (result.ok) {
                const wasBackingOff = failures > 0;
                failures = 0;
                lastData = result.value;
                state.set({ status: 'ready', data: result.value, fetchedAt: new Date() });
                // One success is enough to return to the normal rhythm:
                // an outage that has just ended should not keep the
                // display minutes behind for the rest of the backoff.
                if (wasBackingOff) restartIntervalIfRunning();
            } else {
                setError(new Error(result.error.message));
            }
        } catch (cause) {
            if (isDisposed() || thisGeneration !== generation) return;
            setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
    }

    function setError(error: Error): void {
        failures += 1;
        state.set(lastData === undefined ? { status: 'error', error } : { status: 'error', error, lastData });
        restartIntervalIfRunning();
    }

    function handleVisibilityChange(): void {
        if (document.hidden) {
            stopInterval();
        } else {
            // A tab coming back to the foreground is a person looking at
            // it, which is worth one immediate attempt regardless of how
            // far the backoff had climbed while nobody was watching.
            failures = 0;
            void load();
            startInterval();
        }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (!document.hidden) {
        void load();
        startInterval();
    }

    function refresh(): void {
        if (isDisposed()) return;
        // An explicit refresh is a deliberate ask (the map viewport moved,
        // say), so it is not held back by a backoff the caller knows
        // nothing about.
        failures = 0;
        void load();
        // Only when a timer is already running: a `refresh()` while the tab
        // is hidden (polling deliberately stopped, see above) must not be
        // what starts polling again -- that stays `handleVisibilityChange`'s
        // decision alone.
        restartIntervalIfRunning();
    }

    function dispose(): void {
        disposed = true;
        stopInterval();
        document.removeEventListener('visibilitychange', handleVisibilityChange);
    }

    return { state, refresh, dispose };
}
