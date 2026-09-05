/**
 * Signals, computed values and effects with automatic dependency
 * tracking. See `docs/REACTIVITY.md` for the narrative explanation of how
 * the tracking stack below works and why effect disposal matters.
 */

type Listener = () => void;

/** One (subscriber-set, listener) pair a computation is registered in, so it can unsubscribe before its next run. */
interface Subscription {
    subscribers: Set<Listener>;
    listener: Listener;
}

interface Tracker {
    listener: Listener;
    subscriptions: Subscription[];
}

/** The computation currently being (re)evaluated, if any. Reading a signal while this is set registers that computation as a subscriber. */
let activeTracker: Tracker | undefined;

export interface Signal<T> {
    get(): T;
    set(next: T): void;
    update(fn: (current: T) => T): void;
}

export interface ReadonlySignal<T> {
    get(): T;
}

function track(subscribers: Set<Listener>): void {
    if (!activeTracker) return;
    subscribers.add(activeTracker.listener);
    activeTracker.subscriptions.push({ subscribers, listener: activeTracker.listener });
}

function notify(subscribers: Set<Listener>): void {
    for (const listener of [...subscribers]) listener(); // snapshot: a listener may resubscribe during its run
}

/** Drops `subscriptions` from the previous run, then re-runs `body` with `listener` as the active tracker, refilling `subscriptions`. */
function runTracked(listener: Listener, subscriptions: Subscription[], body: () => void): void {
    for (const s of subscriptions) s.subscribers.delete(s.listener);
    subscriptions.length = 0;
    const previous = activeTracker;
    activeTracker = { listener, subscriptions };
    try {
        body();
    } finally {
        activeTracker = previous;
    }
}

export function signal<T>(initial: T): Signal<T> {
    let value = initial;
    const subscribers = new Set<Listener>();

    function get(): T {
        track(subscribers);
        return value;
    }
    function set(next: T): void {
        if (Object.is(next, value)) return;
        value = next;
        notify(subscribers);
    }
    function update(fn: (current: T) => T): void {
        set(fn(value));
    }

    return { get, set, update };
}

export function computed<T>(fn: () => T): ReadonlySignal<T> {
    const subscribers = new Set<Listener>();
    const subscriptions: Subscription[] = [];
    let value: T;
    let hasValue = false;

    function recompute(): void {
        let next!: T;
        runTracked(recompute, subscriptions, () => {
            next = fn();
        });
        if (!hasValue || !Object.is(next, value)) {
            hasValue = true;
            value = next;
            notify(subscribers);
        }
    }
    recompute();

    return {
        get(): T {
            track(subscribers);
            return value;
        },
    };
}

export function effect(fn: () => (() => void) | undefined): () => void {
    const subscriptions: Subscription[] = [];
    let cleanup: (() => void) | undefined;
    let disposed = false;

    function run(): void {
        if (disposed) return;
        const previousCleanup = cleanup;
        cleanup = undefined; // never invoke the same cleanup twice if fn() throws below
        previousCleanup?.();
        runTracked(run, subscriptions, () => {
            cleanup = fn();
        });
    }
    run();

    return function dispose(): void {
        if (disposed) return;
        disposed = true;
        for (const s of subscriptions) s.subscribers.delete(s.listener);
        subscriptions.length = 0;
        cleanup?.();
        cleanup = undefined;
    };
}
