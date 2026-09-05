import { describe, expect, it, vi } from 'vitest';
import auroraFixture from '../../shared/fixtures/aurora.json' with { type: 'json' };
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import { signal } from '../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { render } = await import('./AuroraPage.js');
const { pageAttribution, pageFreshness } = await import('../shell/page-status.js');

function jsonResponse(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response;
}

describe('AuroraPage', () => {
    it('renders the Kp figure, activity band, bars, stats and the alert band from a cold mount', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-04T21:00:00Z'));

        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(auroraFixture))),
        );
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.aurora-kp-value')).not.toBeNull();
        });

        expect(container.querySelector('.aurora-kp-value')?.textContent).toBe('0'); // kpCurrent.value 0.33, rounded
        expect(container.querySelector('.aurora-band-word')?.textContent).toBe('Aktiv'); // 29 GW is in the 20-50 GW "active" band
        expect(container.querySelectorAll('.aurora-kp-bar-track')).toHaveLength(8);
        expect(container.querySelectorAll('.stat-card')).toHaveLength(3);

        expect(container.querySelector('.aurora-alert-label')?.textContent).toContain('G0');
        expect(container.querySelector('.aurora-alert-text')).not.toBeNull();

        expect(pageAttribution.get()).toBe(auroraFixture.attribution);

        dispose();
        vi.useRealTimers();
    });

    it('shows no alert band at all when there are no alerts', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-04T21:00:00Z'));

        const noAlerts = { ...auroraFixture, alerts: { ...auroraFixture.alerts, alerts: [] } };
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(noAlerts))),
        );
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.aurora-kp-value')).not.toBeNull();
        });

        expect(container.querySelector('.aurora-alert-label')).toBeNull();

        dispose();
        vi.useRealTimers();
    });

    it('shows an error band when the fetch fails, and clears attribution/freshness on unmount', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-04T21:00:00Z'));

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
        vi.useRealTimers();
    });
});
