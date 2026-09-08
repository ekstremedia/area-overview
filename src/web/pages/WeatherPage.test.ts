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

    it('drops the summary heading and byline, leaving the prose alone', async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        // The design reduced the summary to bare prose. Nothing should
        // announce it as a summary or say when it was generated -- but the
        // summary arrives from its own async resource, so wait for the prose
        // first: asserting on an empty slot would pass whether or not the
        // heading was ever removed.
        await vi.waitFor(() => {
            expect(container.querySelector('.weather-summary-text')).not.toBeNull();
        });
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

    it("colours a daily low at or below zero with the hourly strip's freezing colour", async () => {
        const dailyWithSubZero = {
            ...weatherFixture,
            forecast: {
                ...weatherFixture.forecast,
                daily: [
                    { ...weatherFixture.forecast.daily[0], temperature_min: -2, temperature_max: 9 },
                    // Boundary: the legend beside the hourly strip reads
                    // "0° og under", so a rounded 0° belongs to the cold
                    // side here too -- the two rows must not disagree.
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
        expect(zeroLow?.classList.contains('weather-temp-below-zero')).toBe(true);

        dispose();
    });

    it("scales every day's precipitation bar against the wettest day on screen", async () => {
        // The fixture's week: 6.4mm on the third day, 3.1mm on the fourth,
        // nothing on the other three. A full bar stands for 10mm (the
        // rounded-up scale), so those two are 64% and 31% of the track.
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-precip')).toHaveLength(5);
        });

        const widths = [...container.querySelectorAll<HTMLElement>('.weather-daily-day')].map((day) => {
            const fill = day.querySelector<HTMLElement>('.weather-daily-precip-fill');
            return fill ? Math.round(Number.parseFloat(fill.style.width)) : null;
        });

        expect(widths).toEqual([null, null, 64, 31, null]);

        dispose();
    });

    it('gives a dry day its empty track, not a missing one', async () => {
        // "No rain expected" is a forecast; leaving the row out entirely
        // would read as "nothing known about this day".
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-precip')).toHaveLength(5);
        });

        const firstDay = container.querySelector('.weather-daily-day');
        expect(firstDay?.querySelector('.weather-daily-precip')).not.toBeNull();
        expect(firstDay?.querySelector('.weather-daily-precip-fill')).toBeNull();
        expect(firstDay?.querySelector('.weather-daily-precip-amount')).toBeNull();

        dispose();
    });

    it("prints the day's millimetres beside its condition, and only when there are any", async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-precip')).toHaveLength(5);
        });

        const amounts = [...container.querySelectorAll<HTMLElement>('.weather-daily-day')].map(
            (day) => day.querySelector('.weather-daily-precip-amount')?.textContent ?? null,
        );

        expect(amounts).toEqual([null, null, `${formatNumber(6.4)} mm`, `${formatNumber(3.1)} mm`, null]);

        dispose();
    });

    it('names what a full bar stands for', async () => {
        mockFetch(weatherFixture, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.weather-daily-legend')).not.toBeNull();
        });

        // Rounded up from the wettest day (6.4mm) to a figure a legend can
        // name, so the bars are readable as a measure rather than as five
        // relative lengths.
        expect(container.querySelector('.weather-daily-legend')?.textContent).toContain('10 mm');

        dispose();
    });

    it('draws no bars at all for a week with no rain forecast, and says so', async () => {
        const dryWeek = {
            ...weatherFixture,
            forecast: {
                ...weatherFixture.forecast,
                daily: weatherFixture.forecast.daily.map((day) => ({
                    ...day,
                    periods: {
                        night: { precipitation: 0 },
                        morning: { precipitation: 0 },
                        afternoon: { precipitation: 0 },
                        evening: { precipitation: 0 },
                    },
                })),
            },
        };
        mockFetch(dryWeek, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-day')).toHaveLength(5);
        });

        // Five empty tracks under five dry days is decoration; the legend
        // carries the fact instead.
        expect(container.querySelectorAll('.weather-daily-precip')).toHaveLength(0);
        expect(container.querySelector('.weather-daily-legend')?.textContent).toMatch(/ingen ventet|none expected/);

        dispose();
    });

    it('draws nothing for a day the forecast says nothing about', async () => {
        // Yr sends far-future days with no `periods` at all. An empty track
        // there would claim a dry day it has not forecast.
        const noPeriods = {
            ...weatherFixture,
            forecast: {
                ...weatherFixture.forecast,
                daily: [{ ...weatherFixture.forecast.daily[0], periods: undefined }, ...weatherFixture.forecast.daily.slice(1)],
            },
        };
        mockFetch(noPeriods, weatherSummaryFixture);
        const container = document.createElement('div');
        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelectorAll('.weather-daily-day')).toHaveLength(5);
        });

        const days = [...container.querySelectorAll('.weather-daily-day')];
        expect(days[0]?.querySelector('.weather-daily-precip')).toBeNull();
        expect(days[2]?.querySelector('.weather-daily-precip')).not.toBeNull();

        dispose();
    });
});
