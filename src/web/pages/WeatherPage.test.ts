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
        // Deliberately NOT pinning the clock here: buildForecastStrip's backfill
        // logic guarantees FORECAST_HOURS_SHOWN columns regardless of "now" as
        // long as the fixture has at least that many hourly entries (it has 24),
        // so this assertion is robust to the real wall clock.
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

    it('backfills from the tail of the hourly series so the forecast strip always shows FORECAST_HOURS_SHOWN columns, even when "now" is near the end of the fixture data', async () => {
        vi.useFakeTimers();
        // Fixture hourly entries run 2026-09-05T00:00Z..23:00Z (24 entries). Pin
        // "now" to the last entry: under the old "filter-then-slice" logic only
        // the single last entry would be "upcoming" (>= now - 30min), so the
        // strip would have rendered just 1 column instead of 8.
        vi.setSystemTime(new Date('2026-09-05T23:00:00Z'));

        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.weather-temp')).not.toBeNull();
        });

        const columns = container.querySelectorAll('.weather-forecast-column');
        expect(columns).toHaveLength(8);

        const hours = Array.from(columns).map((column) => column.querySelector('.weather-forecast-hour')?.textContent);
        // Backfilled from the tail: the last 8 fixture entries (16:00Z..23:00Z),
        // rendered in the formatter's local timezone.
        const expectedHours = weatherFixture.forecast.hourly
            .slice(-8)
            .map((entry) =>
                new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(entry.time)).slice(0, 2),
            );
        expect(hours).toEqual(expectedHours);

        dispose();
        vi.useRealTimers();
    });

    it('renders nothing at all in the summary slot when the summary is the {summary: null} shape -- no error, no empty box', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));

        mockFetch(weatherFixture, weatherSummaryEmptyFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.weather-temp')).not.toBeNull();
        });

        expect(container.querySelector('.weather-summary')).toBeNull();
        expect(container.querySelector('.weather-summary-label')).toBeNull();

        dispose();
        vi.useRealTimers();
    });

    it('shows the populated summary text in the selected language', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));

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
        vi.useRealTimers();
    });

    it('shows an error band and no crash when the weather fetch fails outright', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));

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
        vi.useRealTimers();
    });

    it('sets and clears page attribution/freshness on mount/unmount', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));

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
        vi.useRealTimers();
    });
});
