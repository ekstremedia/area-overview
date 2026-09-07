import { describe, expect, it, vi } from 'vitest';
import weatherFixture from '../../shared/fixtures/weather.json' with { type: 'json' };
import weatherNetatmoOfflineFixture from '../../shared/fixtures/weather-netatmo-offline.json' with { type: 'json' };
import weatherSummaryFixture from '../../shared/fixtures/weather-summary.json' with { type: 'json' };
import weatherSummaryEmptyFixture from '../../shared/fixtures/weather-summary-empty.json' with { type: 'json' };
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import { signal } from '../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { render } = await import('./WeatherPage.js');
const { pageAttribution, pageFreshness } = await import('../shell/page-status.js');
// Deferred like the imports above -- `../i18n/index.js` itself imports
// `../settings-resource.js`, so a static top-level import here would
// resolve the real module before `vi.mock` above takes effect.
const { formatNumber } = await import('../i18n/index.js');

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
        expect(container.querySelectorAll('.weather-forecast-column')).toHaveLength(12);

        dispose();
    });

    it('renders an icon on every hourly forecast column, sourced from that entry’s real symbol_url', async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-forecast-icon')).toHaveLength(12);
        });

        const icons = Array.from(container.querySelectorAll<HTMLImageElement>('.weather-forecast-icon'));
        expect(icons.every((icon) => icon.src.startsWith('https://nesthus.no/vendor/laravel-yr/symbols/'))).toBe(true);
        expect(icons.every((icon) => icon.alt.length > 0)).toBe(true);

        dispose();
    });

    it('renders the daily forecast section with a day column per shown day, each with an icon and high/low temperatures', async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-day')).toHaveLength(5);
        });

        const days = Array.from(container.querySelectorAll('.weather-daily-day'));
        // First fixture day: temperature_min 8.1, temperature_max 12.1.
        const firstDayTemps = days[0]?.querySelector('.weather-daily-temps');
        expect(firstDayTemps?.querySelector('.weather-daily-high')?.textContent).toBe('12°');
        expect(firstDayTemps?.querySelector('.weather-daily-low')?.textContent).toBe('8°');
        expect(days.every((day) => day.querySelector('.weather-daily-icon') !== null)).toBe(true);

        dispose();
    });

    it('hides the high/low pair only when both temperature_max and temperature_min are absent, not when just one is', async () => {
        const oneNullTemp = {
            ...weatherFixture,
            forecast: {
                ...weatherFixture.forecast,
                daily: [{ ...weatherFixture.forecast.daily[0], temperature_max: null }, ...weatherFixture.forecast.daily.slice(1)],
            },
        };
        mockFetch(oneNullTemp, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-day')).toHaveLength(5);
        });

        const firstDayTemps = container.querySelectorAll('.weather-daily-day')[0]?.querySelector('.weather-daily-temps');
        expect(firstDayTemps?.querySelector('.weather-daily-high')).toBeNull();
        expect(firstDayTemps?.querySelector('.weather-daily-low')?.textContent).toBe('8°');

        dispose();
    });

    it('hides the precipitation stat card (not a placeholder/zero) when rain data is absent, e.g. Netatmo offline', async () => {
        mockFetch(weatherNetatmoOfflineFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.weather-temp')).not.toBeNull();
        });

        // wind, humidity, pressure -- no precipitation card.
        expect(container.querySelectorAll('.stat-card')).toHaveLength(3);

        dispose();
    });

    it('backfills from the tail of the hourly series so the forecast strip always shows FORECAST_HOURS_SHOWN columns, even when "now" is near the end of the fixture data', async () => {
        vi.useFakeTimers();
        // Fixture hourly entries run 2026-09-05T00:00Z..23:00Z (24 entries). Pin
        // "now" to the last entry: under the old "filter-then-slice" logic only
        // the single last entry would be "upcoming" (>= now - 30min), so the
        // strip would have rendered just 1 column instead of FORECAST_HOURS_SHOWN.
        vi.setSystemTime(new Date('2026-09-05T23:00:00Z'));

        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.weather-temp')).not.toBeNull();
        });

        const columns = container.querySelectorAll('.weather-forecast-column');
        expect(columns).toHaveLength(12);

        const hours = Array.from(columns).map((column) => column.querySelector('.weather-forecast-hour')?.textContent);
        // Backfilled from the tail: the last 12 fixture entries (12:00Z..23:00Z),
        // rendered in the formatter's local timezone.
        const expectedHours = weatherFixture.forecast.hourly
            .slice(-12)
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
        expect(pageAttribution.get()).toBe('MET.no / Yr');

        dispose();
        expect(pageAttribution.get()).toBeNull();
        expect(pageFreshness.get()).toBeNull();
        vi.useRealTimers();
    });

    it('drops the summary heading and byline, leaving the prose alone', () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        // The design reduced the summary to bare prose. Nothing should
        // announce it as a summary or say when it was generated.
        expect(container.querySelector('.weather-summary-label')).toBeNull();
        expect(container.querySelector('.weather-summary-age')).toBeNull();

        dispose();
    });

    it('colours each forecast hour by which side of freezing it falls on', async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);
        await vi.waitFor(() => {
            expect(container.querySelector('.weather-forecast-temp')).not.toBeNull();
        });

        const temps = [...container.querySelectorAll<HTMLElement>('.weather-forecast-temp')];
        expect(temps.length).toBeGreaterThan(0);
        for (const temp of temps) {
            const value = Number.parseFloat(temp.textContent.replace(',', '.'));
            // The colour must agree with the *rounded* figure on screen, or
            // a 0.4-degree hour reads "0" in the below-zero colour.
            const expected = value > 0 ? 'weather-temp-above-zero' : 'weather-temp-below-zero';
            expect(temp.classList.contains(expected)).toBe(true);
        }

        // And the legend that explains the two colours is present.
        expect(container.querySelector('.weather-forecast-legend')?.textContent).toContain('0°');

        dispose();
    });

    it("scales every day's range bar against the whole week, so the days can be compared", async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);
        await vi.waitFor(() => {
            expect(container.querySelector('.weather-daily-range-fill')).not.toBeNull();
        });

        const fills = [...container.querySelectorAll<HTMLElement>('.weather-daily-range-fill')];
        expect(fills.length).toBeGreaterThan(1);
        for (const fill of fills) {
            const left = Number.parseFloat(fill.style.left);
            const width = Number.parseFloat(fill.style.width);
            expect(Number.isFinite(left)).toBe(true);
            expect(Number.isFinite(width)).toBe(true);
            // Every bar has to stay inside its own track.
            expect(left).toBeGreaterThanOrEqual(0);
            expect(left + width).toBeLessThanOrEqual(100.01);
            expect(width).toBeGreaterThan(0);
        }
        // The coldest day starts at the very left of the shared scale.
        expect(Math.min(...fills.map((f) => Number.parseFloat(f.style.left)))).toBe(0);

        dispose();
    });

    it("colours a sub-zero daily low with the hourly strip's freezing colour, and leaves an exactly-zero low uncoloured", async () => {
        const dailyWithSubZero = {
            ...weatherFixture,
            forecast: {
                ...weatherFixture.forecast,
                daily: [
                    { ...weatherFixture.forecast.daily[0], temperature_min: -2, temperature_max: 9 },
                    // Boundary: 0 itself reads as "0°", not frost -- same
                    // convention as the hourly strip's own zero handling.
                    { ...weatherFixture.forecast.daily[1], temperature_min: 0, temperature_max: 6 },
                    ...weatherFixture.forecast.daily.slice(2),
                ],
            },
        };
        mockFetch(dailyWithSubZero, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-day')).toHaveLength(5);
        });

        const days = Array.from(container.querySelectorAll('.weather-daily-day'));

        const subZeroLow = days[0]?.querySelector('.weather-daily-low');
        expect(subZeroLow?.textContent).toBe(`${formatNumber(-2)}°`);
        expect(subZeroLow?.classList.contains('weather-temp-below-zero')).toBe(true);

        const zeroLow = days[1]?.querySelector('.weather-daily-low');
        expect(zeroLow?.textContent).toBe(`${formatNumber(0)}°`);
        expect(zeroLow?.classList.contains('weather-temp-below-zero')).toBe(false);

        dispose();
    });

    it("splits a day's range bar into a cyan sub-zero segment and a magenta segment when its range crosses 0°C", async () => {
        const dailyCrossingZero = {
            ...weatherFixture,
            forecast: {
                ...weatherFixture.forecast,
                daily: [{ ...weatherFixture.forecast.daily[0], temperature_min: -2, temperature_max: 8 }, ...weatherFixture.forecast.daily.slice(1)],
            },
        };
        mockFetch(dailyCrossingZero, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-range-fill')).not.toHaveLength(0);
        });

        const firstDay = container.querySelectorAll('.weather-daily-day')[0];
        const belowFill = firstDay?.querySelector<HTMLElement>('.weather-daily-range-fill--below-zero');
        const aboveFill = firstDay?.querySelector<HTMLElement>('.weather-daily-range-fill--above-zero');
        expect(belowFill).not.toBeNull();
        expect(aboveFill).not.toBeNull();

        // Overall week range across the (modified) fixture: min -2 (this
        // day), max 13.5 (2026-09-09) -- span 15.5. This day's own span is
        // -2..8 (10 wide), of which 2/10 is below zero.
        const belowLeft = Number.parseFloat(belowFill?.style.left ?? '');
        const belowWidth = Number.parseFloat(belowFill?.style.width ?? '');
        const aboveLeft = Number.parseFloat(aboveFill?.style.left ?? '');
        const aboveWidth = Number.parseFloat(aboveFill?.style.width ?? '');
        const totalWidth = ((8 - -2) / 15.5) * 100;

        expect(belowLeft).toBeCloseTo(0, 5);
        expect(belowWidth).toBeCloseTo(totalWidth * 0.2, 5);
        expect(aboveLeft).toBeCloseTo(belowWidth, 5);
        expect(aboveWidth).toBeCloseTo(totalWidth * 0.8, 5);

        dispose();
    });

    it('renders a single cyan fill, no magenta segment, for a day whose whole range sits below 0°C', async () => {
        const dailyEntirelyBelowZero = {
            ...weatherFixture,
            forecast: {
                ...weatherFixture.forecast,
                daily: [
                    weatherFixture.forecast.daily[0],
                    { ...weatherFixture.forecast.daily[1], temperature_min: -5, temperature_max: -2 },
                    ...weatherFixture.forecast.daily.slice(2),
                ],
            },
        };
        mockFetch(dailyEntirelyBelowZero, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-range-fill')).not.toHaveLength(0);
        });

        const secondDay = container.querySelectorAll('.weather-daily-day')[1];
        const fills = secondDay?.querySelectorAll('.weather-daily-range-fill') ?? [];
        expect(fills).toHaveLength(1);
        expect(fills[0]?.classList.contains('weather-daily-range-fill--below-zero')).toBe(true);
        expect(fills[0]?.classList.contains('weather-daily-range-fill--above-zero')).toBe(false);

        dispose();
    });
});
