import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from '../../shared/result.js';
import { resource } from './resource.js';

function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
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
});
