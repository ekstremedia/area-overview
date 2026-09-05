import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from '../../shared/result.js';
import { autosave } from './autosave.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('autosave (immediate mode)', () => {
    it('writes exactly once, immediately, per trigger() call', async () => {
        let value = 0;
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { trigger, status } = autosave(() => value, write);

        value = 1;
        trigger();

        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(1);
        await vi.waitFor(() => {
            expect(status.get().kind).toBe('saved');
        });
    });

    it('goes idle -> saving -> saved -> idle (after ~1.5s)', async () => {
        vi.useFakeTimers();
        const write = vi.fn<() => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { trigger, status } = autosave(() => 1, write);

        expect(status.get()).toEqual({ kind: 'idle' });
        trigger();
        expect(status.get()).toEqual({ kind: 'saving' });

        await vi.advanceTimersByTimeAsync(0);
        expect(status.get()).toEqual({ kind: 'saved' });

        await vi.advanceTimersByTimeAsync(1500);
        expect(status.get()).toEqual({ kind: 'idle' });
    });

    it('on failure, status becomes an error and stays there until retry succeeds', async () => {
        vi.useFakeTimers();
        const write = vi
            .fn<() => Promise<Result<unknown>>>()
            .mockResolvedValueOnce(err({ message: 'boom' }))
            .mockResolvedValueOnce(ok(undefined));
        const { trigger, status } = autosave(() => 1, write);

        trigger();
        await vi.advanceTimersByTimeAsync(0);

        const state = status.get();
        if (state.kind !== 'error') throw new Error('expected error');
        expect(state.message).toBe('boom');

        // Stays in error -- does not auto-clear.
        await vi.advanceTimersByTimeAsync(5000);
        expect(status.get().kind).toBe('error');

        state.retry();
        await vi.advanceTimersByTimeAsync(0);
        expect(status.get()).toEqual({ kind: 'saved' });
    });
});

describe('autosave (debounced mode)', () => {
    it('coalesces rapid trigger() calls into exactly one write, using the latest value', async () => {
        vi.useFakeTimers();
        let value = '';
        const write = vi.fn<(v: string) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { trigger, status } = autosave(() => value, write, { debounceMs: 500 });

        value = 'a';
        trigger();
        expect(status.get()).toEqual({ kind: 'pending' });
        await vi.advanceTimersByTimeAsync(100);
        value = 'ab';
        trigger();
        await vi.advanceTimersByTimeAsync(100);
        value = 'abc';
        trigger();

        expect(write).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(500);

        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('abc');
    });

    it('flush() writes immediately without waiting out the debounce window (e.g. on blur)', () => {
        vi.useFakeTimers();
        let value = '';
        const write = vi.fn<(v: string) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { trigger, flush } = autosave(() => value, write, { debounceMs: 500 });

        value = 'typed';
        trigger();
        expect(write).not.toHaveBeenCalled();

        flush();
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('typed');
    });

    it('flush() is a no-op when nothing is pending', () => {
        const write = vi.fn<() => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { flush } = autosave(() => 1, write, { debounceMs: 500 });

        flush();
        expect(write).not.toHaveBeenCalled();
    });
});
