/**
 * The aurora page (artboard 03): the current planetary Kp figure and
 * activity-band word on the left, eight Kp bars and three solar-wind
 * stats below, the OVATION north-hemisphere image and an optional NOAA
 * alert band on the right. Polls `/api/aurora` through its own
 * `resource()` instance, created fresh per mount (see `WeatherPage.ts`'s
 * doc comment for why this app never shares a `resource()` across pages
 * unless it's a genuinely cross-page singleton like `camerasResource`).
 */
import { err, ok, type Result } from '../../shared/result.js';
import { AuroraAllSchema, type AuroraAll } from '../../shared/schemas/aurora.js';
import { errorBand } from '../components/ErrorBand.js';
import { statCard } from '../components/StatCard.js';
import { resource } from '../core/resource.js';
import { effect } from '../core/signal.js';
import { formatNumber, t, type ParamlessKey } from '../i18n/index.js';
import { pageAttribution, pageFreshness } from '../shell/page-status.js';
import { createFreshnessReporter } from '../shell/resourceStatus.js';
import { activityBandForHemisphericPower, type ActivityBand } from './aurora/activityBand.js';
import { firstAlertSummary, hemisphericPowerNorthGw, scaleGLevel, solarWindStats } from './aurora/extract.js';
import { southwardRun } from './aurora/southward.js';
import { buildBzSparkline, buildPlasmaSparkline } from './aurora/sparkline.js';
import { selectKpBars, type KpBar } from './aurora/kpBars.js';
import './aurora/aurora.css';

const AURORA_POLL_INTERVAL_MS = 30_000;

async function fetchAurora(): Promise<Result<AuroraAll>> {
    try {
        const response = await fetch('/api/aurora');
        if (!response.ok) return err({ message: `GET /api/aurora responded ${String(response.status)}` });
        const json: unknown = await response.json();
        const parsed = AuroraAllSchema.safeParse(json);
        if (!parsed.success) return err({ message: 'GET /api/aurora returned a payload that failed schema validation', cause: parsed.error });
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/aurora', cause });
    }
}

const BAND_KEYS: Record<ActivityBand, ParamlessKey> = {
    quiet: 'aurora.band.quiet',
    active: 'aurora.band.active',
    storm: 'aurora.band.storm',
};

function buildKpBarsRow(bars: readonly KpBar[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'aurora-kp-bars';
    const maxKp = 9;
    for (const bar of bars) {
        const track = document.createElement('div');
        track.className = 'aurora-kp-bar-track';
        const fill = document.createElement('div');
        fill.className = `aurora-kp-bar aurora-kp-bar--${bar.kind}`;
        fill.style.height = `${String(Math.min(100, (bar.value / maxKp) * 100))}%`;
        track.append(fill);
        row.append(track);
    }
    return row;
}

function buildLeftColumn(data: AuroraAll): HTMLElement {
    const left = document.createElement('div');
    left.className = 'aurora-left';

    const label = document.createElement('div');
    label.className = 'aurora-kp-label';
    label.textContent = t('aurora.kpLabel');

    const headline = document.createElement('div');
    headline.className = 'aurora-headline';

    const kpValue = document.createElement('div');
    kpValue.className = 'aurora-kp-value';
    kpValue.textContent = formatNumber(Math.round(data.status.kpCurrent.value));

    const bandGroup = document.createElement('div');
    const powerGw = hemisphericPowerNorthGw(data.status.hemisphericPower);
    const band = powerGw === null ? null : activityBandForHemisphericPower(powerGw);

    const bandWord = document.createElement('div');
    bandWord.className = 'aurora-band-word';
    bandWord.textContent = band ? t(BAND_KEYS[band]) : '';

    const power = document.createElement('div');
    power.className = 'aurora-hemispheric-power';
    power.textContent = powerGw === null ? '' : t('aurora.hemisphericPower', { value: formatNumber(powerGw) });

    bandGroup.append(bandWord, power);
    headline.append(kpValue, bandGroup);

    const bars = buildKpBarsRow(selectKpBars(data.indices.kpHistory, data.status.kpCurrent.value, data.status.kpForecast, new Date()));

    const axis = document.createElement('div');
    axis.className = 'aurora-kp-axis';
    // Three separate labels, not one joined string: the row is
    // `space-between`, so only real elements spread to the ends, and "nå"
    // needs to be brighter than the two bounds it sits between.
    for (const [key, className] of [
        ['aurora.kpAxisPast', 'aurora-kp-axis-bound'],
        ['aurora.kpAxisNow', 'aurora-kp-axis-now'],
        ['aurora.kpAxisFuture', 'aurora-kp-axis-bound'],
    ] as const) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = t(key);
        axis.append(span);
    }

    const stats = document.createElement('div');
    stats.className = 'aurora-stats';
    const wind = solarWindStats(data.solarWind.current);

    // Bz gets a caption the other two don't: how long it has been pointing
    // south, which is the part that says whether tonight is worth going
    // outside for. Wrapped so the caption sits under its own card rather
    // than becoming a fourth grid cell.
    const bzCell = document.createElement('div');
    bzCell.className = 'aurora-bz-cell';
    bzCell.append(statCard({ label: t('aurora.bz'), value: wind ? formatNumber(wind.bz) : '—', unit: t('unit.nanotesla'), size: 'lg' }));
    // Each figure gets the recent shape of its own series under it -- the
    // number says where the solar wind is, the line says where it is
    // going, which is the half a glance at a wall display actually needs.
    const bzSpark = buildBzSparkline(data.solarWind.mag);
    if (bzSpark) bzCell.append(bzSpark);
    const run = southwardRun(data.solarWind.mag);
    if (run) {
        const caption = document.createElement('div');
        caption.className = 'aurora-bz-southward';
        const duration = t('aurora.southwardDuration', { minutes: run.minutes });
        caption.textContent = run.atLeast ? t('aurora.southwardAtLeast', { duration }) : t('aurora.southward', { duration });
        bzCell.append(caption);
    }

    const speedCell = document.createElement('div');
    speedCell.className = 'aurora-stat-cell';
    speedCell.append(
        statCard({
            label: t('aurora.solarWindSpeed'),
            value: wind ? formatNumber(Math.round(wind.speed)) : '—',
            unit: t('unit.kilometersPerSecond'),
            size: 'lg',
        }),
    );
    const speedSpark = buildPlasmaSparkline(data.solarWind.plasma, 'speed');
    if (speedSpark) speedCell.append(speedSpark);

    const densityCell = document.createElement('div');
    densityCell.className = 'aurora-stat-cell';
    densityCell.append(
        statCard({ label: t('aurora.density'), value: wind ? formatNumber(wind.density) : '—', unit: t('unit.particlesPerCm3'), size: 'lg' }),
    );
    const densitySpark = buildPlasmaSparkline(data.solarWind.plasma, 'density');
    if (densitySpark) densityCell.append(densitySpark);

    stats.append(bzCell, speedCell, densityCell);

    left.append(label, headline, bars, axis, stats);
    return left;
}

function buildRightColumn(data: AuroraAll): HTMLElement {
    const right = document.createElement('div');
    right.className = 'aurora-right';

    const image = document.createElement('img');
    image.className = 'aurora-oval-image halftone';
    image.loading = 'lazy';
    image.src = data.oval.images.northUrl;
    image.alt = t('aurora.kpLabel');
    right.append(image);

    const gLevel = scaleGLevel(data.status.scales);
    const alertText = firstAlertSummary(data.alerts.alerts);
    if (gLevel !== null && alertText !== null) {
        const alertBand = document.createElement('div');
        const alertLabel = document.createElement('div');
        alertLabel.className = 'aurora-alert-label';
        alertLabel.textContent = t('aurora.noaaAlert', { scale: gLevel });
        const alertBody = document.createElement('div');
        alertBody.className = 'aurora-alert-text';
        alertBody.textContent = alertText;
        alertBand.append(alertLabel, alertBody);
        right.append(alertBand);
    }

    return right;
}

export function render(container: HTMLElement): () => void {
    const wrapper = document.createElement('div');
    wrapper.className = 'aurora-page';

    const errorSlot = document.createElement('div');
    const columns = document.createElement('div');
    columns.className = 'aurora-columns';
    wrapper.append(errorSlot, columns);
    container.append(wrapper);

    const auroraResource = resource(fetchAurora, { intervalMs: AURORA_POLL_INTERVAL_MS });
    const reportFreshness = createFreshnessReporter(AURORA_POLL_INTERVAL_MS);

    const disposeEffect = effect(() => {
        const state = auroraResource.state.get();
        reportFreshness(state);

        errorSlot.innerHTML = '';
        if (state.status === 'error') {
            errorSlot.append(errorBand({ hasStaleData: state.lastData !== undefined }));
        }

        const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.lastData : undefined;

        columns.innerHTML = '';
        if (data) {
            columns.append(buildLeftColumn(data), buildRightColumn(data));
            pageAttribution.set(data.attribution);
        }
    });

    return function dispose(): void {
        disposeEffect();
        auroraResource.dispose();
        pageAttribution.set(null);
        pageFreshness.set(null);
        wrapper.remove();
    };
}
