/**
 * The tide page's 24-hour curve (artboard 04): a hand-drawn SVG, built
 * fresh from the raw timeseries on every poll -- no charting library, no
 * internal state, no animation. `tideCurve` is a pure function: the same
 * `series`/`now`/`extremes` always produce a structurally identical SVG,
 * which is what makes it cheap to rebuild wholesale on every poll (the
 * real fixture is ~148 points) and straightforward to unit test.
 *
 * Colors are set via `style.stroke`/`style.fill` referencing this app's
 * CSS custom properties (`var(--color-accent)`, etc.), not raw hex, so
 * the curve repaints correctly across the light/dark theme switch without
 * needing to be rebuilt.
 */
import type { Tide } from '../../../shared/schemas/tide.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 200;
/** Vertical breathing room so a peak/trough value doesn't touch the very top/bottom edge. */
const Y_PADDING_FRACTION = 0.08;

type TimeseriesEntry = Tide['timeseries'][number];
type ExtremeEntry = Tide['extremes'][number];

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
    return document.createElementNS(SVG_NS, tag);
}

/** A linear time -> x-pixel scale over `[domainStart, domainEnd]` -> `[0, VIEW_WIDTH]`, clamped so an out-of-range time still lands on the chart rather than producing `NaN`/off-canvas coordinates. */
function makeTimeScale(domainStart: number, domainEnd: number): (time: number) => number {
    const span = domainEnd - domainStart;
    return (time: number): number => {
        if (span <= 0) return 0;
        const t = (time - domainStart) / span;
        return Math.min(1, Math.max(0, t)) * VIEW_WIDTH;
    };
}

/** A linear value -> y-pixel scale over `[minValue, maxValue]` -> `[VIEW_HEIGHT * (1-pad), VIEW_HEIGHT * pad]` (inverted: a higher value draws higher on screen, i.e. a smaller y). */
function makeValueScale(minValue: number, maxValue: number): (value: number) => number {
    const span = maxValue - minValue;
    const topY = VIEW_HEIGHT * Y_PADDING_FRACTION;
    const bottomY = VIEW_HEIGHT * (1 - Y_PADDING_FRACTION);
    return (value: number): number => {
        if (span <= 0) return (topY + bottomY) / 2;
        const t = (value - minValue) / span;
        return bottomY - Math.min(1, Math.max(0, t)) * (bottomY - topY);
    };
}

function linePath(points: readonly { x: number; y: number }[]): string {
    return points.map((p, index) => `${index === 0 ? 'M' : 'L'}${String(p.x)},${String(p.y)}`).join(' ');
}

function areaPath(points: readonly { x: number; y: number }[]): string {
    if (points.length === 0) return '';
    const line = linePath(points);
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) return line;
    return `${line} L${String(last.x)},${String(VIEW_HEIGHT)} L${String(first.x)},${String(VIEW_HEIGHT)} Z`;
}

/**
 * Every centimetre value the chart has to fit on its vertical axis:
 * predictions, observations where the gauge has reported one, and the
 * day's extremes.
 *
 * Shared by `tideCurve` and `tideCurveTicks` because they must agree. An
 * observed level outside the predicted range (a storm surge is exactly
 * that) widens the drawn scale, and ticks computed from a narrower set of
 * values would then be positioned against a scale the curve is not using
 * -- labels sliding off the water they claim to measure.
 */
function curveValues(series: readonly TimeseriesEntry[], extremes: readonly ExtremeEntry[]): number[] {
    return [
        ...series.map((entry) => entry.value),
        ...series.flatMap((entry) => (typeof entry.observation === 'number' ? [entry.observation] : [])),
        ...extremes.map((extreme) => extreme.value),
    ];
}

/**
 * Round centimetre values to label the curve's vertical scale with, and
 * where each sits as a percentage down the plotted area.
 *
 * Exported separately from `tideCurve` and rendered as HTML rather than
 * SVG `<text>`: the curve draws with `preserveAspectRatio="none"` so it
 * can stretch to any container width, which would stretch text with it.
 *
 * The step is chosen so the axis gets a handful of labels whatever the
 * day's range: a spring tide spanning 250cm gets 100s, a neap barely
 * moving gets 20s.
 */
export function tideCurveTicks(series: readonly TimeseriesEntry[], extremes: readonly ExtremeEntry[]): { value: number; topPercent: number }[] {
    if (series.length === 0) return [];
    const values = curveValues(series, extremes);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    if (span <= 0) return [];

    const step = [200, 100, 50, 20, 10].find((candidate) => span / candidate >= 2) ?? 10;
    const scale = makeValueScale(min, max);

    const ticks: { value: number; topPercent: number }[] = [];
    for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
        ticks.push({ value, topPercent: (scale(value) / VIEW_HEIGHT) * 100 });
    }
    return ticks;
}

/** One thing worth pointing at on the curve, placed as a percentage of the plotted area. */
export interface TideCurveMarker {
    kind: 'high' | 'low' | 'now';
    leftPercent: number;
    topPercent: number;
    /** Absent for the "now" marker, which is already named by the axis below the curve. */
    label?: { value: number; time: Date };
}

/**
 * Where to put the ringed dots the design sets on each extreme and on the
 * curve's "now" crossing (artboard 04).
 *
 * Positions come back as percentages, and the caller draws them as HTML
 * over the chart, for the same reason `tideCurveTicks` exists: the SVG is
 * `preserveAspectRatio="none"`, so anything drawn inside it is stretched
 * horizontally to fit the container. A circle would become an ellipse and
 * a label would smear. Only the curve itself, whose shape is the point,
 * is allowed to stretch.
 */
export function tideCurveMarkers(series: readonly TimeseriesEntry[], extremes: readonly ExtremeEntry[], now: Date): TideCurveMarker[] {
    if (series.length === 0) return [];

    const timeOf = (entry: { time: string }): number => new Date(entry.time).getTime();
    const times = series.map(timeOf);
    const domainStart = Math.min(...times);
    const domainEnd = Math.max(...times);
    const timeScale = makeTimeScale(domainStart, domainEnd);
    const values = curveValues(series, extremes);
    const valueScale = makeValueScale(Math.min(...values), Math.max(...values));

    const asPercent = (x: number, y: number): { leftPercent: number; topPercent: number } => ({
        leftPercent: (x / VIEW_WIDTH) * 100,
        topPercent: (y / VIEW_HEIGHT) * 100,
    });

    const markers: TideCurveMarker[] = [];

    for (const extreme of extremes) {
        const time = new Date(extreme.time);
        const at = time.getTime();
        // An extreme outside the drawn window would be clamped onto the
        // edge by the scale, landing a "high tide" label on a piece of
        // curve that is not its own.
        if (at < domainStart || at > domainEnd) continue;
        markers.push({
            kind: extreme.type === 'high' ? 'high' : 'low',
            ...asPercent(timeScale(at), valueScale(extreme.value)),
            label: { value: extreme.value, time },
        });
    }

    // The "now" dot sits on the curve, so its height is the interpolated
    // level at this instant rather than any single sample's.
    const level = levelAt(series, now.getTime());
    if (level !== null) {
        markers.push({ kind: 'now', ...asPercent(timeScale(now.getTime()), valueScale(level)) });
    }

    return markers;
}

/** The predicted level at `at`, interpolated between the two samples either side, or `null` when `at` falls outside the series. */
function levelAt(series: readonly TimeseriesEntry[], at: number): number | null {
    const sorted = [...series].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    let previous: TimeseriesEntry | undefined;
    for (const entry of sorted) {
        const time = new Date(entry.time).getTime();
        if (time === at) return entry.value;
        if (time > at) {
            if (!previous) return null; // `at` is before the first sample
            const previousTime = new Date(previous.time).getTime();
            const span = time - previousTime;
            if (span <= 0) return previous.value;
            const t = (at - previousTime) / span;
            return previous.value + (entry.value - previous.value) * t;
        }
        previous = entry;
    }
    return null; // `at` is after the last sample
}

export function tideCurve(series: readonly TimeseriesEntry[], now: Date, extremes: readonly ExtremeEntry[]): SVGElement {
    const svg = svgEl('svg');
    svg.setAttribute('viewBox', `0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'tide-curve');

    if (series.length === 0) return svg;

    const timeOf = (entry: { time: string }): number => new Date(entry.time).getTime();
    const domainStart = Math.min(...series.map(timeOf));
    const domainEnd = Math.max(...series.map(timeOf));
    const timeScale = makeTimeScale(domainStart, domainEnd);

    const allValues = curveValues(series, extremes);
    const valueScale = makeValueScale(Math.min(...allValues), Math.max(...allValues));

    // — the level grid, drawn first so the curve sits on top of it. One
    // rule per tick label, and a solid one at zero: the sea-chart datum is
    // a real reference, the others are only helpful. —
    for (const tick of tideCurveTicks(series, extremes)) {
        const y = valueScale(tick.value);
        const rule = svgEl('line');
        rule.setAttribute('x1', '0');
        rule.setAttribute('x2', String(VIEW_WIDTH));
        rule.setAttribute('y1', String(y));
        rule.setAttribute('y2', String(y));
        rule.setAttribute('class', tick.value === 0 ? 'tide-curve-grid tide-curve-grid--datum' : 'tide-curve-grid');
        rule.style.vectorEffect = 'non-scaling-stroke';
        svg.append(rule);
    }

    // — prediction: the full series, always present. —
    const predictionPoints = series.map((entry) => ({ x: timeScale(timeOf(entry)), y: valueScale(entry.value) }));

    const predictionArea = svgEl('path');
    predictionArea.setAttribute('d', areaPath(predictionPoints));
    predictionArea.setAttribute('class', 'tide-curve-prediction-area');
    predictionArea.style.fill = 'var(--color-accent)';
    predictionArea.style.fillOpacity = '0.12';
    predictionArea.style.stroke = 'none';
    svg.append(predictionArea);

    const predictionLine = svgEl('path');
    predictionLine.setAttribute('d', linePath(predictionPoints));
    predictionLine.setAttribute('class', 'tide-curve-prediction-line');
    predictionLine.setAttribute('fill', 'none');
    predictionLine.style.stroke = 'var(--color-accent)';
    predictionLine.style.strokeWidth = '2.5';
    predictionLine.style.vectorEffect = 'non-scaling-stroke';
    svg.append(predictionLine);

    // — now: a vertical marker, clamped onto the chart even if `now` falls
    // just outside the drawn window (e.g. a slow poll after midnight). —
    const nowX = timeScale(now.getTime());
    const nowLine = svgEl('line');
    nowLine.setAttribute('x1', String(nowX));
    nowLine.setAttribute('x2', String(nowX));
    nowLine.setAttribute('y1', '0');
    nowLine.setAttribute('y2', String(VIEW_HEIGHT));
    nowLine.setAttribute('class', 'tide-curve-now');
    nowLine.style.stroke = 'var(--color-process-yellow)';
    nowLine.style.strokeWidth = '1.5';
    nowLine.style.vectorEffect = 'non-scaling-stroke';
    svg.append(nowLine);

    return svg;
}
