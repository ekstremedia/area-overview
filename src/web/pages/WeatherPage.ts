/**
 * The weather page (artboard 02): Netatmo current conditions on the left,
 * an AI-generated summary and the next-eight-hours Yr strip on the right.
 * Polls `/api/weather` and `/api/weather/summary` through its own two
 * `resource()` instances, created fresh on every mount and disposed on
 * unmount -- deliberately not module-scope singletons (unlike
 * `camerasResource`/`settingsResource`), so a failing aurora/tide/camera
 * fetch elsewhere can never affect this page, and vice versa.
 */
import { err, ok, type Result } from '../../shared/result.js';
import {
    WeatherSchema,
    WeatherSummaryResponseSchema,
    type DailyForecastEntry,
    type Weather,
    type WeatherSummaryResponse,
} from '../../shared/schemas/weather.js';
import { errorBand } from '../components/ErrorBand.js';
import { statCard } from '../components/StatCard.js';
import { resource } from '../core/resource.js';
import { effect } from '../core/signal.js';
import { formatNumber, formatShortDate, formatTime, formatWeekday, t } from '../i18n/index.js';
import { settings } from '../settings-resource.js';
import { pageAttribution, pageFreshness } from '../shell/page-status.js';
import { createFreshnessReporter } from '../shell/resourceStatus.js';
import { compassWord, humanizeSymbolCode } from '../weather-symbols.js';
import './weather.css';

const WEATHER_POLL_INTERVAL_MS = 30_000;
const SUMMARY_POLL_INTERVAL_MS = 30_000;
// 12 columns still reads comfortably at the 1024x600 kiosk size (verified
// with a real screenshot -- see WeatherPage.test.ts/PR description); more
// than that started crowding the new per-column icon.
const FORECAST_HOURS_SHOWN = 12;
// Yr's own UI shows about five days at a glance; the fixture has ten,
// but five is what fits legibly alongside the hourly strip on a 600px-tall
// kiosk screen without either section needing to scroll.
const FORECAST_DAYS_SHOWN = 5;

async function fetchWeather(): Promise<Result<Weather>> {
    try {
        const response = await fetch('/api/weather');
        if (!response.ok) return err({ message: `GET /api/weather responded ${String(response.status)}` });
        const json: unknown = await response.json();
        const parsed = WeatherSchema.safeParse(json);
        if (!parsed.success) return err({ message: 'GET /api/weather returned a payload that failed schema validation', cause: parsed.error });
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/weather', cause });
    }
}

async function fetchWeatherSummary(): Promise<Result<WeatherSummaryResponse>> {
    try {
        const response = await fetch('/api/weather/summary');
        if (!response.ok) return err({ message: `GET /api/weather/summary responded ${String(response.status)}` });
        const json: unknown = await response.json();
        const parsed = WeatherSummaryResponseSchema.safeParse(json);
        if (!parsed.success)
            return err({ message: 'GET /api/weather/summary returned a payload that failed schema validation', cause: parsed.error });
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/weather/summary', cause });
    }
}

/** The populated shape (not the `{summary: null}` not-generated-yet shape). */
function isPopulatedSummary(data: WeatherSummaryResponse): data is Extract<WeatherSummaryResponse, { summary_no: string }> {
    return 'summary_no' in data;
}

function capitalize(text: string): string {
    return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function buildLeftColumn(weather: Weather): HTMLElement {
    const left = document.createElement('div');
    left.className = 'weather-left';

    const label = document.createElement('div');
    label.className = 'weather-outdoor-label';
    label.textContent = t('weather.outdoorLabel');

    const temp = document.createElement('div');
    temp.className = 'weather-temp';
    temp.textContent = `${formatNumber(weather.current.temperature.value)}°`;

    const condition = document.createElement('div');
    condition.className = 'weather-condition';
    condition.textContent = capitalize(
        t('map.pointForecastCondition', {
            condition: humanizeSymbolCode(weather.current.conditions.symbol_code),
            direction: compassWord(weather.current.wind.direction),
        }),
    );

    // 'sm', not this page's original 'md': a single row of four compact
    // cards (see weather.css's `.weather-stats`) instead of a 2x2 grid,
    // freeing the vertical room the new hourly/daily forecast sections
    // below need on the 1024x600 kiosk (measured against a real render --
    // see the PR description for the numbers).
    const stats = document.createElement('div');
    stats.className = 'weather-stats';
    stats.append(
        statCard({ label: t('weather.wind'), value: formatNumber(weather.current.wind.speed), unit: t('unit.metersPerSecond'), size: 'sm' }),
        statCard({ label: t('weather.humidity'), value: formatNumber(weather.current.humidity.value), unit: t('unit.percent'), size: 'sm' }),
        statCard({ label: t('weather.pressure'), value: formatNumber(weather.current.pressure.value), unit: t('unit.hectopascal'), size: 'sm' }),
    );
    // Rain data comes from the Netatmo rain gauge module specifically --
    // absent (not zero) when the station is offline. Following the same
    // convention as `TidePage.ts`'s `ocean` stats: hide the card entirely
    // rather than show a placeholder/zero.
    if (typeof weather.current.rain.last_hour === 'number') {
        stats.append(
            statCard({
                label: t('weather.precipitation'),
                value: formatNumber(weather.current.rain.last_hour),
                unit: t('unit.millimeters'),
                size: 'sm',
            }),
        );
    }

    left.append(label, temp, condition, stats);
    return left;
}

/**
 * The summary reads as plain prose in the right-hand column -- no
 * "Sammendrag" heading and no "generert N min siden" byline, per the
 * 2026-09-07 design and Terje's explicit call to follow it here. It is his
 * own display and he knows where the text comes from; on a wall panel the
 * label was chrome around a paragraph that already explains itself.
 */
function buildSummarySlot(state: WeatherSummaryResponse | undefined): HTMLElement | null {
    if (!state || !isPopulatedSummary(state)) return null;

    const text = document.createElement('div');
    text.className = 'weather-summary-text';
    text.textContent = settings.get().language === 'nb' ? state.summary_no : state.summary_en;
    return text;
}

function buildForecastStrip(weather: Weather, now: Date): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'weather-forecast';

    const firstUpcoming = weather.forecast.hourly.findIndex((entry) => new Date(entry.time).getTime() >= now.getTime() - 30 * 60_000);
    // Anchor on the first not-yet-elapsed hour, but never render a short
    // strip: as the series runs out, slide the window back so the strip
    // always shows FORECAST_HOURS_SHOWN columns when enough data exists.
    const start = firstUpcoming === -1 ? 0 : Math.min(firstUpcoming, Math.max(0, weather.forecast.hourly.length - FORECAST_HOURS_SHOWN));
    const shown = weather.forecast.hourly.slice(start, start + FORECAST_HOURS_SHOWN);

    const header = document.createElement('div');
    header.className = 'weather-forecast-header';
    const label = document.createElement('div');
    label.className = 'weather-forecast-label';
    label.textContent = t('weather.forecastLabel', { hours: shown.length });
    // The strip colours each hour's temperature by which side of freezing
    // it falls on, so the legend is what makes that readable rather than
    // decorative.
    const legend = document.createElement('div');
    legend.className = 'weather-forecast-legend';
    const above = document.createElement('span');
    above.className = 'weather-temp-above-zero';
    above.textContent = t('weather.legendAboveZero');
    const below = document.createElement('span');
    below.className = 'weather-temp-below-zero';
    below.textContent = t('weather.legendBelowZero');
    legend.append(above, below);
    header.append(label, legend);
    strip.append(header);

    const currentHour = now.getHours();
    let currentIndex = shown.findIndex((entry) => new Date(entry.time).getHours() === currentHour);
    if (currentIndex === -1) currentIndex = 0;

    const columns = document.createElement('div');
    columns.className = 'weather-forecast-columns';
    shown.forEach((entry, index) => {
        const column = document.createElement('div');
        column.className = 'weather-forecast-column';
        column.classList.toggle('weather-forecast-column--current', index === currentIndex);

        // Icon beside a small hour-over-temperature stack, not below it --
        // a row uses the kiosk's spare *width* instead of its scarce
        // *height* (see weather.css's file-header comment) to fit both this
        // strip and the daily section below without overlapping either.
        if (entry.symbol_url) {
            const icon = document.createElement('img');
            icon.className = 'weather-forecast-icon';
            icon.loading = 'lazy';
            icon.src = entry.symbol_url;
            icon.alt = humanizeSymbolCode(entry.symbol_code);
            column.append(icon);
        }

        const meta = document.createElement('div');
        meta.className = 'weather-forecast-meta';
        const hourLabel = document.createElement('div');
        hourLabel.className = 'weather-forecast-hour';
        hourLabel.textContent = formatTime(new Date(entry.time)).slice(0, 2);
        const tempLabel = document.createElement('div');
        const rounded = Math.round(entry.temperature);
        // Rounded, not raw: the figure shown and the colour it is given
        // must agree, or a 0.4-degree hour reads as "0°" in the
        // below-zero colour.
        tempLabel.className = `weather-forecast-temp ${rounded > 0 ? 'weather-temp-above-zero' : 'weather-temp-below-zero'}`;
        tempLabel.textContent = `${formatNumber(rounded)}°`;
        meta.append(hourLabel, tempLabel);
        column.append(meta);

        columns.append(column);
    });
    strip.append(columns);

    return strip;
}

function buildDailyDayColumn(entry: DailyForecastEntry, range: DailyTemperatureRange | null): HTMLElement {
    const column = document.createElement('div');
    column.className = 'weather-daily-day';

    // Icon beside the weekday/temps block, not above it -- the same
    // width-over-height trade as the hourly strip's columns (see
    // weather.css's file-header comment). The condition word and range bar
    // then stack underneath this row.
    const head = document.createElement('div');
    head.className = 'weather-daily-day-head';

    if (entry.symbol_url) {
        const icon = document.createElement('img');
        icon.className = 'weather-daily-icon';
        icon.loading = 'lazy';
        icon.src = entry.symbol_url;
        icon.alt = entry.symbol_code ? humanizeSymbolCode(entry.symbol_code) : '';
        head.append(icon);
    }

    const meta = document.createElement('div');
    meta.className = 'weather-daily-meta';

    const weekday = document.createElement('div');
    weekday.className = 'weather-daily-weekday';
    const date = new Date(entry.date);
    // Weekday and short date share one line -- vertical room is the scarce
    // resource on the 1024x600 kiosk once an hourly strip *and* a daily
    // section both need to fit under the current-conditions block.
    weekday.textContent = `${capitalize(formatWeekday(date))} ${formatShortDate(date)}`;
    meta.append(weekday);

    // Hide the pair only when BOTH are absent -- one present figure is
    // still meaningful, not "broken text", the way a lone dash would read.
    if (typeof entry.temperature_max === 'number' || typeof entry.temperature_min === 'number') {
        const temps = document.createElement('div');
        temps.className = 'weather-daily-temps';
        if (typeof entry.temperature_max === 'number') {
            const high = document.createElement('span');
            high.className = 'weather-daily-high';
            high.textContent = `${formatNumber(Math.round(entry.temperature_max))}°`;
            temps.append(high);
        }
        if (typeof entry.temperature_min === 'number') {
            const low = document.createElement('span');
            low.className = 'weather-daily-low';
            low.textContent = `${formatNumber(Math.round(entry.temperature_min))}°`;
            temps.append(low);
        }
        meta.append(temps);
    }

    head.append(meta);
    column.append(head);

    // The condition in words under the figures -- the icon says it too, but
    // only if you already know the icon set, and this line is what makes
    // the day scannable from across the room.
    if (entry.symbol_code) {
        const condition = document.createElement('div');
        condition.className = 'weather-daily-condition';
        condition.textContent = humanizeSymbolCode(entry.symbol_code);
        column.append(condition);
    }

    const bar = buildDailyRangeBar(entry, range);
    if (bar) column.append(bar);

    return column;
}

/** The coldest and warmest figures across the days on screen -- the scale every day's range bar is drawn against. */
interface DailyTemperatureRange {
    min: number;
    max: number;
}

function dailyTemperatureRange(entries: readonly DailyForecastEntry[]): DailyTemperatureRange | null {
    const values: number[] = [];
    for (const entry of entries) {
        if (typeof entry.temperature_min === 'number') values.push(entry.temperature_min);
        if (typeof entry.temperature_max === 'number') values.push(entry.temperature_max);
    }
    if (values.length === 0) return null;
    return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * A day's temperature span drawn against the whole week's span, so five
 * days can be compared at a glance -- a warm day sits right, a cold one
 * left, and a changeable day is wide.
 *
 * Returns `null` rather than an empty track when the day has no figures
 * to place, and falls back to a full-width bar when every day on screen
 * shares one temperature (a zero-width scale would otherwise divide by
 * zero and place nothing).
 */
function buildDailyRangeBar(entry: DailyForecastEntry, range: DailyTemperatureRange | null): HTMLElement | null {
    if (!range) return null;
    const low = typeof entry.temperature_min === 'number' ? entry.temperature_min : entry.temperature_max;
    const high = typeof entry.temperature_max === 'number' ? entry.temperature_max : entry.temperature_min;
    if (typeof low !== 'number' || typeof high !== 'number') return null;

    const span = range.max - range.min;
    const startPercent = span === 0 ? 0 : ((low - range.min) / span) * 100;
    const widthPercent = span === 0 ? 100 : Math.max(((high - low) / span) * 100, 4); // a floor so a flat day is still visible

    const track = document.createElement('div');
    track.className = 'weather-daily-range';
    const fill = document.createElement('div');
    fill.className = 'weather-daily-range-fill';
    fill.style.left = `${String(startPercent)}%`;
    fill.style.width = `${String(Math.min(widthPercent, 100 - startPercent))}%`;
    track.append(fill);
    return track;
}

function buildDailyForecast(weather: Weather): HTMLElement {
    const shown = weather.forecast.daily.slice(0, FORECAST_DAYS_SHOWN);

    const section = document.createElement('div');
    section.className = 'weather-daily';

    const label = document.createElement('div');
    label.className = 'weather-daily-label';
    label.textContent = t('weather.dailyLabel', { days: shown.length });
    section.append(label);

    const list = document.createElement('div');
    list.className = 'weather-daily-list';
    const range = dailyTemperatureRange(shown);
    shown.forEach((entry) => {
        list.append(buildDailyDayColumn(entry, range));
    });
    section.append(list);

    return section;
}

export function render(container: HTMLElement): () => void {
    const wrapper = document.createElement('div');
    wrapper.className = 'weather-page';

    const errorSlot = document.createElement('div');
    const columns = document.createElement('div');
    columns.className = 'weather-columns';
    const left = document.createElement('div');
    const right = document.createElement('div');
    right.className = 'weather-right';
    columns.append(left, right);

    // Own flex items of `.weather-page` (unlike `.weather-forecast`/
    // `.weather-daily`, which get swapped in and out inside these on every
    // fetch) -- `flex: 1 1 0` lives on these slot classes so the space
    // freed by the current-conditions row no longer growing to fill the
    // page (see weather.css) goes to the forecast sections instead.
    const forecastSlot = document.createElement('div');
    forecastSlot.className = 'weather-forecast-slot';
    const dailySlot = document.createElement('div');
    dailySlot.className = 'weather-daily-slot';

    wrapper.append(errorSlot, columns, forecastSlot, dailySlot);
    container.append(wrapper);

    const weatherResource = resource(fetchWeather, { intervalMs: WEATHER_POLL_INTERVAL_MS });
    const summaryResource = resource(fetchWeatherSummary, { intervalMs: SUMMARY_POLL_INTERVAL_MS });

    const reportFreshness = createFreshnessReporter(WEATHER_POLL_INTERVAL_MS);

    const disposeWeatherEffect = effect(() => {
        const state = weatherResource.state.get();
        reportFreshness(state);

        errorSlot.innerHTML = '';
        if (state.status === 'error') {
            errorSlot.append(errorBand({ hasStaleData: state.lastData !== undefined }));
        }

        const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.lastData : undefined;

        left.innerHTML = '';
        forecastSlot.innerHTML = '';
        dailySlot.innerHTML = '';
        if (data) {
            left.append(buildLeftColumn(data));
            forecastSlot.append(buildForecastStrip(data, new Date()));
            dailySlot.append(buildDailyForecast(data));
        }
    });

    const disposeSummaryEffect = effect(() => {
        const state = summaryResource.state.get();
        const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.lastData : undefined;

        right.innerHTML = '';
        const slot = buildSummarySlot(data);
        if (slot) right.append(slot);
    });

    const disposeAttributionEffect = effect(() => {
        pageAttribution.set(t('weather.attributionText'));
    });

    return function dispose(): void {
        disposeWeatherEffect();
        disposeSummaryEffect();
        disposeAttributionEffect();
        weatherResource.dispose();
        summaryResource.dispose();
        pageAttribution.set(null);
        pageFreshness.set(null);
        wrapper.remove();
    };
}
