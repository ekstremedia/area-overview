/**
 * The tide page (artboard 04): current level + trend, next high/low tide,
 * a 24-hour prediction/observation curve (`tide/curve.ts`), and optional
 * sea-state stats (hidden entirely, not shown empty, when `ocean` is
 * absent from the response -- not every station upstream proxies has an
 * ocean-forecast product). Polls `/api/tide` through its own
 * `resource()` instance, created fresh per mount (see `WeatherPage.ts`'s
 * doc comment for why).
 */
import { err, ok, type Result } from '../../shared/result.js';
import { TideSchema, type Tide } from '../../shared/schemas/tide.js';
import { errorBand } from '../components/ErrorBand.js';
import { statCard } from '../components/StatCard.js';
import { resource } from '../core/resource.js';
import { effect } from '../core/signal.js';
import { formatNumber, formatRelative, formatTime, t, type ParamlessKey } from '../i18n/index.js';
import { pageAttribution, pageFreshness } from '../shell/page-status.js';
import { createFreshnessReporter } from '../shell/resourceStatus.js';
import { tideCurve } from './tide/curve.js';
import './tide/tide.css';

const TIDE_POLL_INTERVAL_MS = 30_000;
const AXIS_MARK_COUNT = 8;

async function fetchTide(): Promise<Result<Tide>> {
    try {
        const response = await fetch('/api/tide');
        if (!response.ok) return err({ message: `GET /api/tide responded ${String(response.status)}` });
        const json: unknown = await response.json();
        const parsed = TideSchema.safeParse(json);
        if (!parsed.success) return err({ message: 'GET /api/tide returned a payload that failed schema validation', cause: parsed.error });
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/tide', cause });
    }
}

function levelText(valueCm: number): string {
    return `${formatNumber(Math.round(valueCm))} ${t('unit.centimeters')}`;
}

function deviationText(value: number): string {
    const rounded = Math.round(value);
    const sign = rounded > 0 ? '+' : '';
    return `${sign}${formatNumber(rounded)} ${t('unit.centimeters')}`;
}

function trendText(trend: string, deviation: string): string {
    if (trend === 'rising') return t('tide.trendRising', { deviation });
    if (trend === 'falling') return t('tide.trendFalling', { deviation });
    return t('tide.trendSteady', { deviation });
}

function buildTrendLine(tide: Tide): HTMLElement | null {
    if (!tide.observedDeviation) return null;
    const trend = document.createElement('div');
    trend.className = 'tide-level-trend';
    trend.textContent = trendText(tide.currentLevel.trend, deviationText(tide.observedDeviation.value));
    return trend;
}

function buildLevelNowColumn(tide: Tide): HTMLElement {
    const col = document.createElement('div');
    col.className = 'tide-column';

    const label = document.createElement('div');
    label.className = 'tide-column-label tide-column-label--accent';
    label.textContent = t('tide.levelNowLabel');

    const value = document.createElement('div');
    value.className = 'tide-level-value';
    const num = document.createElement('span');
    num.textContent = formatNumber(Math.round(tide.currentLevel.value));
    const unit = document.createElement('span');
    unit.className = 'tide-level-unit';
    unit.textContent = ` ${t('unit.centimeters')}`;
    value.append(num, unit);

    col.append(label, value);
    const trend = buildTrendLine(tide);
    if (trend) col.append(trend);

    return col;
}

function buildNextExtremeColumn(labelKey: ParamlessKey, time: string, valueCm: number, now: Date): HTMLElement {
    const col = document.createElement('div');
    col.className = 'tide-column';

    const label = document.createElement('div');
    label.className = 'tide-column-label';
    label.textContent = t(labelKey);

    const clock = document.createElement('div');
    clock.className = 'tide-next-time';
    clock.textContent = formatTime(new Date(time));

    const line = document.createElement('div');
    line.className = 'tide-next-line';
    line.textContent = t('tide.nextExtremeLine', { relative: formatRelative(new Date(time), now), level: levelText(valueCm) });

    col.append(label, clock, line);
    return col;
}

function buildAxis(tide: Tide, now: Date): HTMLElement {
    const axis = document.createElement('div');
    axis.className = 'tide-axis';

    const start = new Date(tide.windowStart).getTime();
    const end = new Date(tide.windowEnd).getTime();
    const span = end - start || 1;
    const marks = Array.from({ length: AXIS_MARK_COUNT }, (_, i) => start + (i / (AXIS_MARK_COUNT - 1)) * span);

    let nowIndex = 0;
    let nowDistance = Infinity;
    marks.forEach((mark, index) => {
        const distance = Math.abs(mark - now.getTime());
        if (distance < nowDistance) {
            nowDistance = distance;
            nowIndex = index;
        }
    });

    marks.forEach((mark, index) => {
        const el = document.createElement('span');
        if (index === nowIndex) {
            el.className = 'tide-axis-now';
            el.textContent = t('tide.nowAxis', { time: formatTime(now) });
        } else {
            el.textContent = String(new Date(mark).getHours()).padStart(2, '0');
        }
        axis.append(el);
    });

    return axis;
}

function buildCurveSection(tide: Tide, now: Date): HTMLElement {
    const section = document.createElement('div');
    section.className = 'tide-curve-section';

    const header = document.createElement('div');
    header.className = 'tide-curve-header';
    const label = document.createElement('div');
    label.className = 'tide-column-label';
    label.textContent = t('tide.curveLabel');
    const legend = document.createElement('div');
    legend.className = 'tide-legend';
    const predictionSwatch = document.createElement('span');
    predictionSwatch.className = 'tide-legend-swatch tide-legend-swatch--prediction';
    const observedSwatch = document.createElement('span');
    observedSwatch.className = 'tide-legend-swatch tide-legend-swatch--observed';
    legend.append(
        predictionSwatch,
        document.createTextNode(t('tide.legendPrediction')),
        observedSwatch,
        document.createTextNode(t('tide.legendObserved')),
    );
    header.append(label, legend);

    const curveWrap = document.createElement('div');
    curveWrap.className = 'tide-curve-wrap';
    curveWrap.append(tideCurve(tide.timeseries, now, tide.extremes));

    section.append(header, curveWrap, buildAxis(tide, now));
    return section;
}

function buildSeaStateRow(tide: Tide): HTMLElement | null {
    if (!tide.ocean) return null;
    const { current } = tide.ocean;
    const cards: HTMLElement[] = [];
    if (typeof current.sea_water_temperature === 'number') {
        cards.push(statCard({ value: formatNumber(current.sea_water_temperature), unit: t('unit.seaTemperature'), size: 'sm' }));
    }
    if (typeof current.sea_surface_wave_height === 'number') {
        cards.push(statCard({ value: formatNumber(current.sea_surface_wave_height), unit: t('unit.wave'), size: 'sm' }));
    }
    if (typeof current.sea_water_speed === 'number') {
        cards.push(statCard({ value: formatNumber(current.sea_water_speed), unit: t('unit.metersPerSecondSea'), size: 'sm' }));
    }
    if (cards.length === 0) return null;

    const row = document.createElement('div');
    row.className = 'tide-sea-state';
    row.append(...cards);
    return row;
}

export function render(container: HTMLElement): () => void {
    const wrapper = document.createElement('div');
    wrapper.className = 'tide-page';

    const errorSlot = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'tide-body';
    wrapper.append(errorSlot, body);
    container.append(wrapper);

    const tideResource = resource(fetchTide, { intervalMs: TIDE_POLL_INTERVAL_MS });
    const reportFreshness = createFreshnessReporter(TIDE_POLL_INTERVAL_MS);

    const disposeEffect = effect(() => {
        const state = tideResource.state.get();
        reportFreshness(state);

        errorSlot.innerHTML = '';
        if (state.status === 'error') {
            errorSlot.append(errorBand({ hasStaleData: state.lastData !== undefined }));
        }

        const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.lastData : undefined;

        body.innerHTML = '';
        if (data) {
            const now = new Date();

            const topRow = document.createElement('div');
            topRow.className = 'tide-top-row';
            topRow.append(
                buildLevelNowColumn(data),
                buildNextExtremeColumn('tide.nextHighLabel', data.nextHighTide.time, data.nextHighTide.value, now),
                buildNextExtremeColumn('tide.nextLowLabel', data.nextLowTide.time, data.nextLowTide.value, now),
            );

            body.append(topRow, buildCurveSection(data, now));

            const seaState = buildSeaStateRow(data);
            if (seaState) body.append(seaState);

            pageAttribution.set(data.attribution);
        }
    });

    return function dispose(): void {
        disposeEffect();
        tideResource.dispose();
        pageAttribution.set(null);
        pageFreshness.set(null);
        wrapper.remove();
    };
}
