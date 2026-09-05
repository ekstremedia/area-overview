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
    dispose(): void;
}

export interface ResourceOptions {
    intervalMs: number;
}

export function resource<T>(fetcher: () => Promise<Result<T>>, options: ResourceOptions): Resource<T> {
    const state = signal<ResourceState<T>>({ status: 'idle' });
    let lastData: T | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
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

    function startInterval(): void {
        stopInterval();
        timer = setInterval(() => void load(), options.intervalMs);
    }

    async function load(): Promise<void> {
        if (isDisposed()) return;
        state.set({ status: 'loading' });
        try {
            const result = await fetcher();
            if (isDisposed()) return;
            if (result.ok) {
                lastData = result.value;
                state.set({ status: 'ready', data: result.value, fetchedAt: new Date() });
            } else {
                setError(new Error(result.error.message));
            }
        } catch (cause) {
            if (isDisposed()) return;
            setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
    }

    function setError(error: Error): void {
        state.set(lastData === undefined ? { status: 'error', error } : { status: 'error', error, lastData });
    }

    function handleVisibilityChange(): void {
        if (document.hidden) {
            stopInterval();
        } else {
            void load();
            startInterval();
        }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (!document.hidden) {
        void load();
        startInterval();
    }

    function dispose(): void {
        disposed = true;
        stopInterval();
        document.removeEventListener('visibilitychange', handleVisibilityChange);
    }

    return { state, dispose };
}
