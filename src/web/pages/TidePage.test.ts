import { describe, expect, it, vi } from 'vitest';
import tideFixture from '../../shared/fixtures/tide.json' with { type: 'json' };
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import { signal } from '../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { render } = await import('./TidePage.js');
const { pageAttribution, pageFreshness } = await import('../shell/page-status.js');

function jsonResponse(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response;
}

describe('TidePage', () => {
    it('renders level-now, next high/low tide, and the curve from a cold mount', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(tideFixture))),
        );
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.tide-level-value')).not.toBeNull();
        });

        expect(container.querySelector('.tide-level-value')?.textContent).toContain('118');
        expect(container.querySelectorAll('.tide-column')).toHaveLength(3);
        expect(container.querySelector('.tide-curve-wrap svg')).not.toBeNull();
        expect(container.querySelector('.tide-level-trend')?.textContent).toContain('stiger');

        dispose();
    });

    it('shows sea-state stat cards when ocean is present', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(tideFixture))),
        );
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.tide-sea-state')).not.toBeNull();
        });
        expect(container.querySelectorAll('.tide-sea-state .stat-card')).toHaveLength(3);

        dispose();
    });

    it('hides the sea-state row entirely (not shown empty) when ocean is absent', async () => {
        const withoutOcean = Object.fromEntries(Object.entries(tideFixture).filter(([key]) => key !== 'ocean'));
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(withoutOcean))),
        );
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.tide-level-value')).not.toBeNull();
        });
        expect(container.querySelector('.tide-sea-state')).toBeNull();

        dispose();
    });

    it('shows an error band on a fetch failure, and clears attribution/freshness on unmount', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new Error('network down'))),
        );
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.error-band')).not.toBeNull();
        });

        dispose();
        expect(pageAttribution.get()).toBeNull();
        expect(pageFreshness.get()).toBeNull();
    });
});
