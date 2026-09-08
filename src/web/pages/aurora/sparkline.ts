/**
 * The three small line charts under the aurora page's Bz / solar-wind /
 * density figures (artboard 03).
 *
 * A single number says what the solar wind is doing *now*; these say
 * whether it is on its way up or down, which is most of what you actually
 * want from a wall display you glance at. The design draws them at
 * 170x22 with `preserveAspectRatio="none"`, so the drawing happens in a
 * fixed 170x30 coordinate space and the browser stretches it to whatever
 * width the column ends up.
 *
 * Bz gets a richer treatment than the other two, because its sign is the
 * thing that matters: the zero line is drawn, the stretch that is
 * currently southward is picked out in magenta and filled down to that
 * line, and everything before it stays muted. The split comes from
 * `southwardRunStartIndex`, the same boundary the "sørvendt i 4 t"
 * caption counts from -- the colour and the words can never disagree.
 *
 * `solarWind.mag`/`solarWind.plasma` reach here unvalidated (the aurora
 * schema types them as opaque records), so every reader below skips
 * anything malformed rather than trusting it, exactly as `southward.ts`
 * does.
 */
import { readMagPoints, southwardRunStartIndex } from './southward.js';

const VIEW_WIDTH = 170;
const VIEW_HEIGHT = 30;
/** Kept off the very top and bottom edge so a peak isn't clipped to a flat line by the stroke's own width. */
const PADDING_Y = 4;

const SVG_NS = 'http://www.w3.org/2000/svg';

interface SeriesPoint {
    time: number;
    value: number;
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
    return document.createElementNS(SVG_NS, name);
}

/** The shared frame: a fixed drawing space stretched to the column's width, and inert to assistive tech (the figure above it already carries the number). */
function sparklineRoot(className: string): SVGSVGElement {
    const svg = svgEl('svg');
    svg.setAttribute('viewBox', `0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
}

/** Pulls `{time, <key>}` pairs out of one of the unvalidated solar-wind blobs, oldest first. */
export function readSeries(blob: unknown, key: string): SeriesPoint[] {
    if (typeof blob !== 'object' || blob === null) return [];
    const raw = (blob as { points?: unknown }).points;
    if (!Array.isArray(raw)) return [];

    const points: SeriesPoint[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { time } = entry as { time?: unknown };
        const value = (entry as Record<string, unknown>)[key];
        if (typeof time !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) continue;
        const parsed = Date.parse(time);
        if (Number.isNaN(parsed)) continue;
        points.push({ time: parsed, value });
    }
    points.sort((a, b) => a.time - b.time);
    return points;
}

/**
 * Maps values onto the drawing space. A flat series (every reading
 * identical, which the upstream does serve) would divide by zero, so it
 * is drawn down the middle instead -- the honest picture of "nothing is
 * changing".
 */
function makeScale(min: number, max: number): (value: number) => number {
    const span = max - min;
    if (span <= 0) return () => VIEW_HEIGHT / 2;
    const usable = VIEW_HEIGHT - 2 * PADDING_Y;
    return (value) => VIEW_HEIGHT - PADDING_Y - ((value - min) / span) * usable;
}

/** Evenly spaced across the full width: these are regular cadence samples, so the x axis carries no information beyond order. */
function makeXScale(count: number): (index: number) => number {
    if (count <= 1) return () => VIEW_WIDTH;
    return (index) => (index / (count - 1)) * VIEW_WIDTH;
}

function round(value: number): string {
    return (Math.round(value * 100) / 100).toString();
}

function linePath(points: readonly { x: number; y: number }[]): string {
    return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)},${round(point.y)}`).join(' ');
}

function pathEl(d: string, stroke: string, width: string): SVGPathElement {
    const path = svgEl('path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', width);
    // The horizontal stretch would otherwise thin the stroke to a hairline.
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    return path;
}

function endpointDot(x: number, y: number, fill: string, radius: string): SVGCircleElement {
    const dot = svgEl('circle');
    dot.setAttribute('cx', round(x));
    dot.setAttribute('cy', round(y));
    dot.setAttribute('r', radius);
    dot.setAttribute('fill', fill);
    return dot;
}

/**
 * Bz over the upstream window, with the current southward run picked out
 * and filled to the zero line. Returns `null` when there is nothing
 * usable to draw, so the caller renders the figure without a chart rather
 * than an empty box.
 */
export function buildBzSparkline(mag: unknown): SVGSVGElement | null {
    const points = readMagPoints(mag);
    if (points.length < 2) return null;

    const values = points.map((point) => point.bz);
    // Zero is always in range: this chart is *about* the sign of Bz, and a
    // zero line outside the drawn area would be a chart that hides its own
    // subject.
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const y = makeScale(min, max);
    const x = makeXScale(points.length);

    const svg = sparklineRoot('aurora-spark aurora-spark--bz');
    const coords = points.map((point, index) => ({ x: x(index), y: y(point.bz) }));
    const zeroY = y(0);

    const runStart = southwardRunStartIndex(points);

    if (runStart !== null) {
        const runCoords = coords.slice(runStart);
        const first = runCoords[0];
        const last = runCoords[runCoords.length - 1];
        if (first && last) {
            const area = svgEl('path');
            area.setAttribute('d', `${linePath(runCoords)} L${round(last.x)},${round(zeroY)} L${round(first.x)},${round(zeroY)} Z`);
            area.setAttribute('class', 'aurora-spark-area');
            area.setAttribute('stroke', 'none');
            svg.append(area);
        }
    }

    const zeroLine = svgEl('line');
    zeroLine.setAttribute('x1', '0');
    zeroLine.setAttribute('x2', String(VIEW_WIDTH));
    zeroLine.setAttribute('y1', round(zeroY));
    zeroLine.setAttribute('y2', round(zeroY));
    zeroLine.setAttribute('class', 'aurora-spark-zero');
    zeroLine.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(zeroLine);

    // Everything before the run (or the whole line, when Bz is northward
    // now) stays muted; the run itself is the loud part.
    const historyEnd = runStart === null ? coords.length : runStart + 1;
    const history = coords.slice(0, historyEnd);
    if (history.length >= 2) {
        const path = pathEl(linePath(history), 'currentColor', '1.5');
        path.setAttribute('class', 'aurora-spark-history');
        svg.append(path);
    }

    if (runStart !== null) {
        const runCoords = coords.slice(runStart);
        if (runCoords.length >= 2) {
            const path = pathEl(linePath(runCoords), 'currentColor', '2');
            path.setAttribute('class', 'aurora-spark-run');
            svg.append(path);
        }
    }

    const last = coords[coords.length - 1];
    if (last) {
        const dot = endpointDot(last.x, last.y, 'currentColor', '2.6');
        dot.setAttribute('class', runStart === null ? 'aurora-spark-dot' : 'aurora-spark-dot aurora-spark-dot--run');
        svg.append(dot);
    }

    return svg;
}

/**
 * Solar-wind speed or density over the same window: a plain line with a
 * dashed reference at the window's own midpoint, so a rise reads as a
 * rise without needing an axis.
 */
export function buildPlasmaSparkline(plasma: unknown, key: 'speed' | 'density'): SVGSVGElement | null {
    const points = readSeries(plasma, key);
    if (points.length < 2) return null;

    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const y = makeScale(min, max);
    const x = makeXScale(points.length);

    const svg = sparklineRoot(`aurora-spark aurora-spark--${key}`);

    const midpoint = svgEl('line');
    midpoint.setAttribute('x1', '0');
    midpoint.setAttribute('x2', String(VIEW_WIDTH));
    midpoint.setAttribute('y1', round(y((min + max) / 2)));
    midpoint.setAttribute('y2', round(y((min + max) / 2)));
    midpoint.setAttribute('class', 'aurora-spark-midline');
    midpoint.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(midpoint);

    const coords = points.map((point, index) => ({ x: x(index), y: y(point.value) }));
    const path = pathEl(linePath(coords), 'currentColor', '1.5');
    path.setAttribute('class', 'aurora-spark-line');
    svg.append(path);

    const last = coords[coords.length - 1];
    if (last) {
        const dot = endpointDot(last.x, last.y, 'currentColor', '2.5');
        dot.setAttribute('class', 'aurora-spark-dot');
        svg.append(dot);
    }

    return svg;
}
