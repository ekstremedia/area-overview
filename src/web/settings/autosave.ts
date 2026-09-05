/**
 * The one autosave engine every settings control in this app is built on
 * -- there is no save button anywhere (see the phase's own non-goal
 * list), so every edit eventually flows through here.
 *
 * Two modes, picked per-field by the caller via `options.debounceMs`:
 *  - immediate (0/omitted): a toggle/select/stepper's `onChange` has
 *    already mutated the underlying value by the time it calls
 *    `trigger()`, so `trigger()` writes once, right away.
 *  - debounced (e.g. 500ms): rapid `trigger()` calls coalesce into one
 *    write of the *latest* value once the debounce window elapses. A
 *    caller can also `flush()` to force that write immediately (blur,
 *    Enter) so a value typed and then tapped away from is never lost to
 *    an un-fired timer.
 *
 * `status` never auto-clears an error -- it stays `{kind:'error', ...}`
 * until `retry()` succeeds or another `trigger()`/`flush()` starts a new
 * attempt. A `saved` status is transient (~1.5s) purely as UI feedback.
 */
import { signal, type ReadonlySignal } from '../core/signal.js';
import type { Result } from '../../shared/result.js';

export type AutosaveStatus =
    { kind: 'idle' } | { kind: 'pending' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string; retry: () => void };

export interface AutosaveOptions {
    /** 0/omitted = write immediately on every `trigger()`. Otherwise, the debounce window in ms. */
    debounceMs?: number;
    /** How long `{kind:'saved'}` is shown before reverting to `{kind:'idle'}`. Defaults to 1500ms. */
    savedDisplayMs?: number;
}

export interface Autosave {
    status: ReadonlySignal<AutosaveStatus>;
    /**
     * Signals an edit happened. In debounced mode this (re)starts the
     * debounce timer; in immediate mode it writes right away. Declared as
     * a function-typed property (not a method signature) so destructuring
     * `{ trigger, flush }` out of the returned object -- the normal way a
     * form control consumes this -- never trips
     * `@typescript-eslint/unbound-method`; neither closure reads `this`.
     */
    trigger: () => void;
    /** Forces any pending debounced write to happen now (blur, Enter). A no-op if nothing is pending. */
    flush: () => void;
    /**
     * Cancels any pending debounced write without triggering it -- used when
     * the field's value has since become invalid, so the last-known-valid
     * value never gets silently written after the user has already moved on
     * to editing something that doesn't parse. A no-op if nothing is
     * pending; does not affect a write already in flight (that one already
     * left the debounce stage and is mid-`fetch`).
     */
    cancel: () => void;
}

const DEFAULT_SAVED_DISPLAY_MS = 1500;

export function autosave<T>(read: () => T, write: (value: T) => Promise<Result<unknown>>, options: AutosaveOptions = {}): Autosave {
    const debounceMs = options.debounceMs ?? 0;
    const savedDisplayMs = options.savedDisplayMs ?? DEFAULT_SAVED_DISPLAY_MS;

    const status = signal<AutosaveStatus>({ kind: 'idle' });
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let savedTimer: ReturnType<typeof setTimeout> | undefined;
    // Monotonically increasing token: if a newer write starts while an
    // older one is still in flight, the older one's eventual resolution
    // must not clobber the newer one's status.
    let inFlightToken = 0;

    function clearDebounceTimer(): void {
        if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
        }
    }

    function clearSavedTimer(): void {
        if (savedTimer !== undefined) {
            clearTimeout(savedTimer);
            savedTimer = undefined;
        }
    }

    async function runWrite(): Promise<void> {
        clearDebounceTimer();
        const token = ++inFlightToken;
        clearSavedTimer();
        status.set({ kind: 'saving' });

        const value = read();
        const result = await write(value);

        if (token !== inFlightToken) return; // superseded by a newer write

        if (result.ok) {
            status.set({ kind: 'saved' });
            savedTimer = setTimeout(() => {
                if (token === inFlightToken) status.set({ kind: 'idle' });
            }, savedDisplayMs);
        } else {
            status.set({
                kind: 'error',
                message: result.error.message,
                retry: () => {
                    void runWrite();
                },
            });
        }
    }

    function trigger(): void {
        if (debounceMs <= 0) {
            void runWrite();
            return;
        }
        clearDebounceTimer();
        clearSavedTimer();
        status.set({ kind: 'pending' });
        debounceTimer = setTimeout(() => {
            void runWrite();
        }, debounceMs);
    }

    function flush(): void {
        if (debounceTimer === undefined) return;
        clearDebounceTimer();
        void runWrite();
    }

    function cancel(): void {
        if (debounceTimer === undefined) return;
        clearDebounceTimer();
        status.set({ kind: 'idle' });
    }

    return { status, trigger, flush, cancel };
}
