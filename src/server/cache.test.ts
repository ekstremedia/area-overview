import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from './cache.js';

describe('TtlCache', () => {
    it('returns a fresh value without calling the loader again', async () => {
        const cache = new TtlCache<string>(10_000);
        const loader = vi.fn().mockResolvedValue('value-1');

        const first = await cache.getOrLoad('key', loader);
        const second = await cache.getOrLoad('key', loader);

        expect(first).toBe('value-1');
        expect(second).toBe('value-1');
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('reloads once the entry has expired', async () => {
        vi.useFakeTimers();
        try {
            const cache = new TtlCache<string>(1_000);
            const loader = vi.fn().mockResolvedValueOnce('value-1').mockResolvedValueOnce('value-2');

            const first = await cache.getOrLoad('key', loader);
            expect(first).toBe('value-1');

            vi.advanceTimersByTime(1_001);

            const second = await cache.getOrLoad('key', loader);
            expect(second).toBe('value-2');
            expect(loader).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('exposes an expired entry as stale rather than dropping it', () => {
        vi.useFakeTimers();
        try {
            const cache = new TtlCache<string>(1_000);
            cache.set('key', 'value-1');

            expect(cache.get('key')).toEqual({ value: 'value-1', stale: false });

            vi.advanceTimersByTime(1_001);

            expect(cache.get('key')).toEqual({ value: 'value-1', stale: true });
        } finally {
            vi.useRealTimers();
        }
    });

    it('single-flights concurrent loads for the same key', async () => {
        const cache = new TtlCache<string>(10_000);
        let resolveLoader!: (value: string) => void;
        const loader = vi.fn(
            () =>
                new Promise<string>((resolve) => {
                    resolveLoader = resolve;
                }),
        );

        const first = cache.getOrLoad('key', loader);
        const second = cache.getOrLoad('key', loader);

        expect(loader).toHaveBeenCalledTimes(1);

        resolveLoader('value-1');

        await expect(first).resolves.toBe('value-1');
        await expect(second).resolves.toBe('value-1');
    });

    it('evicts the least-recently-used entry once maxEntries is exceeded', () => {
        const cache = new TtlCache<string>(10_000, { maxEntries: 2 });
        cache.set('a', 'value-a');
        cache.set('b', 'value-b');
        cache.set('c', 'value-c'); // evicts 'a', the least-recently-used

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toEqual({ value: 'value-b', stale: false });
        expect(cache.get('c')).toEqual({ value: 'value-c', stale: false });
    });

    it('a get() refreshes recency, protecting a recently-read key from eviction', () => {
        const cache = new TtlCache<string>(10_000, { maxEntries: 2 });
        cache.set('a', 'value-a');
        cache.set('b', 'value-b');

        cache.get('a'); // touch 'a' so it is no longer the least-recently-used

        cache.set('c', 'value-c'); // now 'b' is least-recently-used, not 'a'

        expect(cache.get('a')).toEqual({ value: 'value-a', stale: false });
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('c')).toEqual({ value: 'value-c', stale: false });
    });

    it('has no cap at all when maxEntries is left unset', () => {
        const cache = new TtlCache<string>(10_000);
        for (let i = 0; i < 50; i++) {
            cache.set(`key-${String(i)}`, `value-${String(i)}`);
        }

        expect(cache.get('key-0')).toEqual({ value: 'value-0', stale: false });
        expect(cache.get('key-49')).toEqual({ value: 'value-49', stale: false });
    });

    it('does not cache a failed load, leaving a stale entry available', async () => {
        const cache = new TtlCache<string>(1);
        cache.set('key', 'stale-value');
        await new Promise((resolve) => setTimeout(resolve, 5));

        const loader = vi.fn().mockRejectedValue(new Error('boom'));

        await expect(cache.getOrLoad('key', loader)).rejects.toThrow('boom');

        const entry = cache.get('key');
        expect(entry).toEqual({ value: 'stale-value', stale: true });
    });
});
