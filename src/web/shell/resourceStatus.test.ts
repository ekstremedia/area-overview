import { describe, expect, it } from 'vitest';
import { createFreshnessReporter } from './resourceStatus.js';
import { pageFreshness } from './page-status.js';

describe('createFreshnessReporter', () => {
    it('reports null until the first successful fetch, then the fetch time thereafter -- even across a later error', () => {
        const report = createFreshnessReporter(30_000);

        report({ status: 'idle' });
        expect(pageFreshness.get()).toBeNull();

        report({ status: 'loading' });
        expect(pageFreshness.get()).toBeNull();

        const fetchedAt = new Date('2026-09-05T12:00:00Z');
        report({ status: 'ready', data: 'x', fetchedAt });
        expect(pageFreshness.get()).toEqual({ fetchedAt, intervalMs: 30_000 });

        report({ status: 'error', error: new Error('boom') });
        expect(pageFreshness.get()).toEqual({ fetchedAt, intervalMs: 30_000 }); // still the last good fetch, not cleared

        pageFreshness.set(null);
    });
});
