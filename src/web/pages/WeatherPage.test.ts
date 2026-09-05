import { describe, expect, it, vi } from 'vitest';
import weatherFixture from '../../shared/fixtures/weather.json' with { type: 'json' };
import weatherSummaryFixture from '../../shared/fixtures/weather-summary.json' with { type: 'json' };
import weatherSummaryEmptyFixture from '../../shared/fixtures/weather-summary-empty.json' with { type: 'json' };
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import { signal } from '../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { render } = await import('./WeatherPage.js');
const { pageAttribution, pageFreshness } = await import('../shell/page-status.js');

function jsonResponse(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response;
}

function mockFetch(weatherBody: unknown, summaryBody: unknown): void {
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            if (url.startsWith('/api/weather/summary')) return Promise.resolve(jsonResponse(summaryBody));
            if (url.startsWith('/api/weather')) return Promise.resolve(jsonResponse(weatherBody));
            return Promise.reject(new Error(`unexpected fetch: ${url}`));
        }),
    );
}

describe('WeatherPage', () => {
    it('renders temperature, condition and stat cards from a cold mount, no prior navigation', async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.weather-temp')).not.toBeNull();
        });

        expect(container.querySelector('.weather-temp')?.textContent).toBe('6,2°');
        expect(container.querySelectorAll('.stat-card')).toHaveLength(4);
        expect(container.querySelectorAll('.weather-forecast-column')).toHaveLength(8);

        dispose();
    });

    it('renders nothing at all in the summary slot when the summary is the {summary: null} shape -- no error, no empty box', async () => {
        mockFetch(weatherFixture, weatherSummaryEmptyFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.weather-temp')).not.toBeNull();
        });

        expect(container.querySelector('.weather-summary')).toBeNull();
        expect(container.querySelector('.weather-summary-label')).toBeNull();

        dispose();
    });

    it('shows the populated summary text in the selected language', async () => {
        mockSettings.set(SettingsSchema.parse({ language: 'en' }));
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.weather-summary-text')).not.toBeNull();
        });

        expect(container.querySelector('.weather-summary-text')?.textContent).toBe(weatherSummaryFixture.summary_en);

        mockSettings.set(SettingsSchema.parse({}));
        dispose();
    });

    it('shows an error band and no crash when the weather fetch fails outright', async () => {
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
    });

    it('sets and clears page attribution/freshness on mount/unmount', async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(pageFreshness.get()).not.toBeNull();
        });
        expect(pageAttribution.get()).toBe('MET.no / Yr · Netatmo');

        dispose();
        expect(pageAttribution.get()).toBeNull();
        expect(pageFreshness.get()).toBeNull();
    });
});
