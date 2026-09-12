import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from '../../shared/result.js';
import { resource } from './resource.js';
import { computed, effect } from './signal.js';

function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
});

describe('resource refresh', () => {
    it('fetches immediately and pushes the next poll a full interval out', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(ok('x'));
        const res = resource(fetcher, { intervalMs: 10_000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(6_000); // 6s into the interval
        res.refresh();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(2); // fetched now, not in 4s

        // Had the interval kept its original phase, the scheduled poll would
        // land 4s from here, right on the refresh's heels.
        await vi.advanceTimersByTimeAsync(9_999);
        expect(fetcher).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1);
        expect(fetcher).toHaveBeenCalledTimes(3);

        res.dispose();
    });

    it('does not start polling when refreshed while the tab is hidden', async () => {
        vi.useFakeTimers();
        setHidden(true);
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(ok('x'));
        const res = resource(fetcher, { intervalMs: 1_000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).not.toHaveBeenCalled(); // hidden: no initial load, no timer

        res.refresh();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(1); // the explicit ask is honoured...

        await vi.advanceTimersByTimeAsync(5_000);
        expect(fetcher).toHaveBeenCalledTimes(1); // ...but it must not resume polling

        res.dispose();
    });

    it('is inert after dispose', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(ok('x'));
        const res = resource(fetcher, { intervalMs: 10_000 });
        await vi.advanceTimersByTimeAsync(0);
        res.dispose();

        res.refresh();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

describe('resource', () => {
    it('transitions idle -> loading -> ready on a successful fetch', async () => {
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(ok('hello'));
        const res = resource(fetcher, { intervalMs: 10_000 });

        expect(res.state.get().status).toBe('loading');
        await vi.waitFor(() => {
            expect(res.state.get().status).toBe('ready');
        });

        const state = res.state.get();
        if (state.status !== 'ready') throw new Error('expected ready');
        expect(state.data).toBe('hello');
        expect(state.fetchedAt).toBeInstanceOf(Date);

        res.dispose();
    });

    it('transitions to error, preserving lastData from a prior success', async () => {
        vi.useFakeTimers();
        const fetcher = vi
            .fn<() => Promise<Result<string>>>()
            .mockResolvedValueOnce(ok('first'))
            .mockResolvedValueOnce(err({ message: 'boom' }));
        const res = resource(fetcher, { intervalMs: 1_000 });

        await vi.advanceTimersByTimeAsync(0); // let the immediate fetch resolve
        expect(res.state.get()).toMatchObject({ status: 'ready', data: 'first' });

        await vi.advanceTimersByTimeAsync(1_000); // the interval fires the failing second fetch
        const state = res.state.get();
        if (state.status !== 'error') throw new Error('expected error');
        expect(state.error.message).toBe('boom');
        expect(state.lastData).toBe('first');

        res.dispose();
    });

    it('turns a thrown/rejected fetch into an error state instead of an unhandled rejection', async () => {
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockRejectedValue(new Error('network down'));
        const res = resource(fetcher, { intervalMs: 10_000 });

        await vi.waitFor(() => {
            expect(res.state.get().status).toBe('error');
        });
        const state = res.state.get();
        if (state.status !== 'error') throw new Error('expected error');
        expect(state.error.message).toBe('network down');
        expect(state.lastData).toBeUndefined();

        res.dispose();
    });

    it('pauses polling while hidden and refetches immediately when visibility returns', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<() => Promise<Result<number>>>().mockImplementation(() => Promise.resolve(ok(1)));
        const res = resource(fetcher, { intervalMs: 1_000 });

        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(1);

        setHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));

        // Hidden: advancing well past several intervals must not trigger any more fetches.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetcher).toHaveBeenCalledTimes(1);

        setHidden(false);
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);

        // Coming back visible refetches immediately, not after waiting out a full interval.
        expect(fetcher).toHaveBeenCalledTimes(2);

        res.dispose();
    });

    it('24-hour soak: polling every 30s leaves no timer/listener/fetch-count drift', async () => {
        vi.useFakeTimers();
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');

        const fetcher = vi.fn<() => Promise<Result<number>>>().mockImplementation(() => Promise.resolve(ok(1)));
        const intervalMs = 30_000;
        const res = resource(fetcher, { intervalMs });

        const twentyFourHoursMs = 24 * 60 * 60 * 1000;
        await vi.advanceTimersByTimeAsync(twentyFourHoursMs);

        // 1 immediate fetch + one per elapsed interval -- exact, so any accumulation/drift shows up.
        const expectedFetches = twentyFourHoursMs / intervalMs + 1;
        expect(fetcher).toHaveBeenCalledTimes(expectedFetches);
        expect(res.state.get().status).toBe('ready');

        res.dispose();

        // Disposal removed exactly the one visibilitychange listener resource() added.
        const visibilityAdds = addSpy.mock.calls.filter(([type]) => type === 'visibilitychange').length;
        const visibilityRemoves = removeSpy.mock.calls.filter(([type]) => type === 'visibilitychange').length;
        expect(visibilityAdds).toBe(1);
        expect(visibilityRemoves).toBe(1);

        // Timer is really gone: advancing further causes no further fetches.
        await vi.advanceTimersByTimeAsync(intervalMs * 10);
        expect(fetcher).toHaveBeenCalledTimes(expectedFetches);

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });

    it('a refresh poll does not regress `ready` back to `loading` while it is in flight', async () => {
        vi.useFakeTimers();
        let resolveSecond: ((result: Result<string>) => void) | undefined;
        const fetcher = vi
            .fn<() => Promise<Result<string>>>()
            .mockResolvedValueOnce(ok('first'))
            .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
        const res = resource(fetcher, { intervalMs: 1_000 });

        await vi.advanceTimersByTimeAsync(0);
        expect(res.state.get()).toMatchObject({ status: 'ready', data: 'first' });

        // The interval fires the second (refresh) fetch, which is still pending.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetcher).toHaveBeenCalledTimes(2);
        // Must still show the old ready data, not `loading`, while the refresh is in flight.
        expect(res.state.get()).toMatchObject({ status: 'ready', data: 'first' });

        resolveSecond?.(ok('second'));
        await vi.advanceTimersByTimeAsync(0);
        expect(res.state.get()).toMatchObject({ status: 'ready', data: 'second' });

        res.dispose();
    });

    it('discards a stale, out-of-order resolution from an older in-flight call', async () => {
        vi.useFakeTimers();
        const deferreds: ((result: Result<string>) => void)[] = [];
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockImplementation(
            () =>
                new Promise((resolve) => {
                    deferreds.push(resolve);
                }),
        );
        const res = resource(fetcher, { intervalMs: 1_000 });

        // Call N fires immediately on creation and stays in flight.
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(1);

        // Call N+1 fires from the interval while call N is still pending.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(deferreds).toHaveLength(2);

        // Resolve the newer call (N+1) first.
        deferreds[1]?.(ok('newer'));
        await vi.advanceTimersByTimeAsync(0);
        expect(res.state.get()).toMatchObject({ status: 'ready', data: 'newer' });

        // The older call (N) resolves late; its result must be discarded entirely,
        // not even reflected as `lastData` on a subsequent read.
        deferreds[0]?.(ok('older-and-stale'));
        await vi.advanceTimersByTimeAsync(0);
        expect(res.state.get()).toMatchObject({ status: 'ready', data: 'newer' });

        res.dispose();
    });

    it('a settings-like computed built on resource() never transiently reads the default across N poll cycles', async () => {
        vi.useFakeTimers();
        const DEFAULT_VALUE = 300;
        let currentValue = 111;
        const fetcher = vi.fn<() => Promise<Result<number>>>().mockImplementation(() => Promise.resolve(ok(currentValue)));
        const res = resource(fetcher, { intervalMs: 1_000 });

        // Mirrors src/web/settings-resource.ts's `settings` computed.
        const derived = computed<number>(() => {
            const state = res.state.get();
            switch (state.status) {
                case 'ready':
                    return state.data;
                case 'error':
                    return state.lastData ?? DEFAULT_VALUE;
                case 'idle':
                case 'loading':
                    return DEFAULT_VALUE;
            }
        });

        const seenStatuses: string[] = [];
        const disposeEffect = effect(() => {
            seenStatuses.push(res.state.get().status);
        });

        await vi.advanceTimersByTimeAsync(0); // first load resolves
        expect(res.state.get().status).toBe('ready');
        expect(derived.get()).toBe(111);

        for (let i = 0; i < 5; i++) {
            currentValue = 200 + i;
            await vi.advanceTimersByTimeAsync(1_000);
            // Never observes the default mid-poll: `state` must already be back to
            // `ready` with the new value, never `loading` in between.
            expect(res.state.get().status).toBe('ready');
            expect(derived.get()).toBe(currentValue);
        }

        // `loading` must have been observed exactly once: for the very first load.
        const loadingCount = seenStatuses.filter((status) => status === 'loading').length;
        expect(loadingCount).toBe(1);

        disposeEffect();
        res.dispose();
    });
});

describe('resource backoff on repeated failure', () => {
    it('doubles the poll interval per consecutive failure, so a failing service is not hammered by every open tab', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(err({ message: 'upstream down' }));
        const res = resource(fetcher, { intervalMs: 1_000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(1); // the initial load failed: 1 failure

        // One failure in hand, so the next poll is 2s out, not 1s.
        await vi.advanceTimersByTimeAsync(1_999);
        expect(fetcher).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetcher).toHaveBeenCalledTimes(2);

        // Two failures: 4s.
        await vi.advanceTimersByTimeAsync(3_999);
        expect(fetcher).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetcher).toHaveBeenCalledTimes(3);

        res.dispose();
    });

    it('caps the backoff rather than growing without bound', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(err({ message: 'upstream down' }));
        const res = resource(fetcher, { intervalMs: 1_000, maxBackoffMs: 4_000 });
        await vi.advanceTimersByTimeAsync(0);

        // Let it climb well past where an uncapped doubling would be.
        await vi.advanceTimersByTimeAsync(60_000);
        const callsAfterOneMinute = fetcher.mock.calls.length;

        // At the 4s ceiling a further minute is ~15 more polls; uncapped
        // doubling would have stopped polling entirely by now.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(callsAfterOneMinute + 10);

        res.dispose();
    });

    it('snaps back to the normal interval on the first success, so recovery is not itself delayed', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(err({ message: 'upstream down' }));
        const res = resource(fetcher, { intervalMs: 1_000 });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(2_000); // second attempt, still failing
        await vi.advanceTimersByTimeAsync(4_000); // third attempt, still failing
        const callsWhileFailing = fetcher.mock.calls.length;

        fetcher.mockResolvedValue(ok('back'));
        await vi.advanceTimersByTimeAsync(8_000); // the backed-off poll succeeds
        expect(fetcher).toHaveBeenCalledTimes(callsWhileFailing + 1);

        // Back to a 1s rhythm immediately, not still crawling.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetcher).toHaveBeenCalledTimes(callsWhileFailing + 2);

        res.dispose();
    });

    it('gives a tab returning to the foreground one immediate attempt, however far the backoff had climbed', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(err({ message: 'upstream down' }));
        const res = resource(fetcher, { intervalMs: 1_000 });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(30_000); // several failures, well backed off
        const backedOffCalls = fetcher.mock.calls.length;

        setHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));
        setHidden(false);
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);

        expect(fetcher).toHaveBeenCalledTimes(backedOffCalls + 1);

        // That attempt failed too, so the backoff starts over from one
        // failure rather than resuming where it left off: 2s, not the 1s
        // of a healthy resource nor the half-minute it had climbed to.
        await vi.advanceTimersByTimeAsync(1_999);
        expect(fetcher).toHaveBeenCalledTimes(backedOffCalls + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetcher).toHaveBeenCalledTimes(backedOffCalls + 2);

        res.dispose();
    });

    it('does not hold an explicit refresh back behind a backoff the caller knows nothing about', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(err({ message: 'upstream down' }));
        const res = resource(fetcher, { intervalMs: 1_000 });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(30_000);
        const backedOffCalls = fetcher.mock.calls.length;

        res.refresh();
        await vi.advanceTimersByTimeAsync(0);

        expect(fetcher).toHaveBeenCalledTimes(backedOffCalls + 1);

        res.dispose();
    });
});

describe('resource backoff ceiling validation', () => {
    it('never polls a failing resource faster than a healthy one, whatever ceiling the caller passes', async () => {
        vi.useFakeTimers();
        for (const maxBackoffMs of [0, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
            const fetcher = vi.fn<() => Promise<Result<string>>>().mockResolvedValue(err({ message: 'upstream down' }));
            const res = resource(fetcher, { intervalMs: 1_000, maxBackoffMs });
            await vi.advanceTimersByTimeAsync(0);
            expect(fetcher).toHaveBeenCalledTimes(1);

            // A ceiling below `intervalMs` would make this fire sooner --
            // a "backoff" that speeds up under failure.
            await vi.advanceTimersByTimeAsync(999);
            expect(fetcher).toHaveBeenCalledTimes(1);

            res.dispose();
        }
    });
});
