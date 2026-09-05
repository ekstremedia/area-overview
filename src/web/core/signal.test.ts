import { describe, expect, it, vi } from 'vitest';
import { computed, effect, signal } from './signal.js';

describe('signal', () => {
    it('reads back the initial value and updates via set/update', () => {
        const count = signal(1);
        expect(count.get()).toBe(1);

        count.set(2);
        expect(count.get()).toBe(2);

        count.update((current) => current + 10);
        expect(count.get()).toBe(12);
    });
});

describe('computed', () => {
    it('reflects the current value of a dependency it reads', () => {
        const count = signal(1);
        const doubled = computed(() => count.get() * 2);

        expect(doubled.get()).toBe(2);
        count.set(5);
        expect(doubled.get()).toBe(10);
    });

    it('does not recompute when a signal it never read changes', () => {
        const a = signal(1);
        const b = signal(100);
        const spy = vi.fn(() => a.get() * 2);
        const doubledA = computed(spy);

        expect(doubledA.get()).toBe(2);
        expect(spy).toHaveBeenCalledTimes(1);

        b.set(999); // unrelated write
        expect(spy).toHaveBeenCalledTimes(1); // no extra recompute
        expect(doubledA.get()).toBe(2);
    });

    it('tracks only the branch actually taken when dependencies are conditional', () => {
        const flag = signal(true);
        const a = signal('a-1');
        const b = signal('b-1');
        const spy = vi.fn(() => (flag.get() ? a.get() : b.get()));
        const chosen = computed(spy);

        expect(chosen.get()).toBe('a-1');
        expect(spy).toHaveBeenCalledTimes(1);

        // While on the `a` branch, changing `b` must not trigger a recompute.
        b.set('b-2');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(chosen.get()).toBe('a-1');

        // Switching branches re-subscribes: now `a` is dropped and `b` is picked up.
        flag.set(false);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(chosen.get()).toBe('b-2');

        a.set('a-2'); // no longer depended on
        expect(spy).toHaveBeenCalledTimes(2);
        expect(chosen.get()).toBe('b-2');

        b.set('b-3'); // still depended on
        expect(spy).toHaveBeenCalledTimes(3);
        expect(chosen.get()).toBe('b-3');
    });
});

describe('effect', () => {
    it('runs immediately and re-runs when a dependency changes', () => {
        const count = signal(1);
        const seen: number[] = [];

        effect(() => {
            seen.push(count.get());
        });

        expect(seen).toEqual([1]);
        count.set(2);
        expect(seen).toEqual([1, 2]);
    });

    it('runs cleanup before each re-run and on disposal', () => {
        const count = signal(1);
        const events: string[] = [];

        const dispose = effect(() => {
            const value = count.get();
            events.push(`run:${String(value)}`);
            return () => events.push(`cleanup:${String(value)}`);
        });

        count.set(2);
        expect(events).toEqual(['run:1', 'cleanup:1', 'run:2']);

        dispose();
        expect(events).toEqual(['run:1', 'cleanup:1', 'run:2', 'cleanup:2']);
    });

    it('stops running and removes its subscription once disposed', () => {
        const count = signal(1);
        const spy = vi.fn();

        const dispose = effect(() => {
            spy(count.get());
        });
        expect(spy).toHaveBeenCalledTimes(1);

        dispose();
        count.set(2);
        expect(spy).toHaveBeenCalledTimes(1); // no re-run after disposal
    });

    it('does not leak subscriptions: 100 create+dispose cycles leave the signal exactly as responsive as before', () => {
        const source = signal(0);
        let controlRuns = 0;

        // A long-lived effect acts as an observable proxy for "how many listeners actually
        // fire per `set()`" -- it must fire exactly once per set(), no matter how much
        // create/dispose churn happens on other, already-disposed effects in between.
        effect(() => {
            source.get();
            controlRuns += 1;
        });
        expect(controlRuns).toBe(1);

        for (let i = 0; i < 100; i++) {
            let churnRuns = 0;
            const dispose = effect(() => {
                source.get();
                churnRuns += 1;
            });
            expect(churnRuns).toBe(1);
            dispose();

            source.set(i + 1); // after disposal, this churned effect must never run again
            expect(churnRuns).toBe(1);
        }

        // The long-lived control effect saw exactly one run per set(): 1 initial + 100 loop sets.
        expect(controlRuns).toBe(101);
    });
});
