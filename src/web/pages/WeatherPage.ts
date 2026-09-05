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
import { WeatherSchema, WeatherSummaryResponseSchema, type Weather, type WeatherSummaryResponse } from '../../shared/schemas/weather.js';
import { errorBand } from '../components/ErrorBand.js';
import { statCard } from '../components/StatCard.js';
import { resource } from '../core/resource.js';
import { effect } from '../core/signal.js';
import { formatNumber, formatRelative, formatTime, t } from '../i18n/index.js';
import { settings } from '../settings-resource.js';
import { pageAttribution, pageFreshness } from '../shell/page-status.js';
import { createFreshnessReporter } from '../shell/resourceStatus.js';
import { compassWord, humanizeSymbolCode } from '../weather-symbols.js';
import './weather.css';

const WEATHER_POLL_INTERVAL_MS = 30_000;
const SUMMARY_POLL_INTERVAL_MS = 30_000;
const FORECAST_HOURS_SHOWN = 8;

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

    const stats = document.createElement('div');
    stats.className = 'weather-stats';
    stats.append(
        statCard({ label: t('weather.wind'), value: formatNumber(weather.current.wind.speed), unit: t('unit.metersPerSecond'), size: 'md' }),
        statCard({ label: t('weather.humidity'), value: formatNumber(weather.current.humidity.value), unit: t('unit.percent'), size: 'md' }),
        statCard({ label: t('weather.pressure'), value: formatNumber(weather.current.pressure.value), unit: t('unit.hectopascal'), size: 'md' }),
        statCard({
            label: t('weather.precipitation'),
            value: formatNumber(weather.current.rain.last_hour),
            unit: t('unit.millimeters'),
            size: 'md',
        }),
    );

    left.append(label, temp, condition, stats);
    return left;
}

function buildSummarySlot(state: WeatherSummaryResponse | undefined): HTMLElement | null {
    if (!state || !isPopulatedSummary(state)) return null;

    const slot = document.createElement('div');
    slot.className = 'weather-summary';

    const header = document.createElement('div');
    header.className = 'weather-summary-header';
    const label = document.createElement('div');
    label.className = 'weather-summary-label';
    label.textContent = t('weather.summaryLabel');
    const age = document.createElement('div');
    age.className = 'weather-summary-age';
    age.textContent = t('weather.summaryGenerated', { age: formatRelative(new Date(state.generated_at)) });
    header.append(label, age);

    const text = document.createElement('div');
    text.className = 'weather-summary-text';
    text.textContent = settings.get().language === 'nb' ? state.summary_no : state.summary_en;

    slot.append(header, text);
    return slot;
}

function buildForecastStrip(weather: Weather, now: Date): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'weather-forecast';

    const label = document.createElement('div');
    label.className = 'weather-forecast-label';
    label.textContent = t('weather.forecastLabel');
    strip.append(label);

    const firstUpcoming = weather.forecast.hourly.findIndex((entry) => new Date(entry.time).getTime() >= now.getTime() - 30 * 60_000);
    // Anchor on the first not-yet-elapsed hour, but never render a short
    // strip: as the series runs out, slide the window back so the strip
    // always shows FORECAST_HOURS_SHOWN columns when enough data exists.
    const start = firstUpcoming === -1 ? 0 : Math.min(firstUpcoming, Math.max(0, weather.forecast.hourly.length - FORECAST_HOURS_SHOWN));
    const shown = weather.forecast.hourly.slice(start, start + FORECAST_HOURS_SHOWN);

    const temps = shown.map((entry) => entry.temperature);
    const minTemp = Math.min(...temps);
    const maxTemp = Math.max(...temps);
    const span = maxTemp - minTemp || 1;

    const currentHour = now.getHours();
    let currentIndex = shown.findIndex((entry) => new Date(entry.time).getHours() === currentHour);
    if (currentIndex === -1) currentIndex = 0;

    const columns = document.createElement('div');
    columns.className = 'weather-forecast-columns';
    shown.forEach((entry, index) => {
        const column = document.createElement('div');
        column.className = 'weather-forecast-column';

        const barTrack = document.createElement('div');
        barTrack.className = 'weather-forecast-bar-track';
        const bar = document.createElement('div');
        bar.className = 'weather-forecast-bar';
        bar.classList.toggle('weather-forecast-bar--current', index === currentIndex);
        const heightPercent = 30 + ((entry.temperature - minTemp) / span) * 70;
        bar.style.height = `${String(heightPercent)}%`;
        barTrack.append(bar);

        const tempLabel = document.createElement('div');
        tempLabel.className = 'weather-forecast-temp';
        tempLabel.textContent = `${formatNumber(Math.round(entry.temperature))}°`;

        const hourLabel = document.createElement('div');
        hourLabel.className = 'weather-forecast-hour';
        hourLabel.textContent = formatTime(new Date(entry.time)).slice(0, 2);

        column.append(barTrack, tempLabel, hourLabel);
        columns.append(column);
    });
    strip.append(columns);

    return strip;
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

    const forecastSlot = document.createElement('div');

    wrapper.append(errorSlot, columns, forecastSlot);
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
        if (data) {
            left.append(buildLeftColumn(data));
            forecastSlot.append(buildForecastStrip(data, new Date()));
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
