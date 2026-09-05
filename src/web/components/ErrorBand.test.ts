import { describe, expect, it } from 'vitest';
import { errorBand } from './ErrorBand.js';

describe('errorBand', () => {
    it('renders a "showing earlier data" message when stale data exists', () => {
        const el = errorBand({ hasStaleData: true });
        expect(el.textContent).toContain('tidligere data');
    });

    it('renders a "no data available" message when there is nothing to fall back to', () => {
        const el = errorBand({ hasStaleData: false });
        expect(el.textContent).toBe('Ingen data tilgjengelig.');
    });
});
