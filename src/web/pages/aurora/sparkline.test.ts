import { describe, expect, it } from 'vitest';
import { buildBzSparkline, buildPlasmaSparkline, readSeries } from './sparkline.js';

/** `solarWind.plasma`/`mag` as the upstream serves them: oldest first, one point every five minutes. */
function blob(key: string, values: readonly unknown[]): unknown {
    const start = Date.parse('2026-09-07T15:00:00Z');
    return {
        points: values.map((value, index) => ({ time: new Date(start + index * 5 * 60_000).toISOString(), [key]: value })),
    };
}

/** The `d` of every path in the chart, in document order. */
function paths(svg: SVGSVGElement | null): string[] {
    return [...(svg?.querySelectorAll('path') ?? [])].map((path) => path.getAttribute('d') ?? '');
}

function yOf(command: string): number {
    return Number(command.split(',')[1]);
}

describe('readSeries', () => {
    it('skips malformed points rather than trusting the unvalidated blob', () => {
        const points = readSeries(
            {
                points: [
                    { time: 'not a date', speed: 500 },
                    { time: '2026-09-07T15:00:00Z', speed: 'fast' },
                    null,
                    { time: '2026-09-07T15:05:00Z', speed: 480 },
                ],
            },
            'speed',
        );

        expect(points).toEqual([{ time: Date.parse('2026-09-07T15:05:00Z'), value: 480 }]);
    });

    it('rejects a non-finite reading, which would otherwise poison the whole scale', () => {
        expect(readSeries({ points: [{ time: '2026-09-07T15:00:00Z', speed: Number.NaN }] }, 'speed')).toEqual([]);
    });

    it('sorts by time rather than trusting the array order', () => {
        const points = readSeries(
            {
                points: [
                    { time: '2026-09-07T15:05:00Z', density: 2 },
                    { time: '2026-09-07T15:00:00Z', density: 1 },
                ],
            },
            'density',
        );

        expect(points.map((point) => point.value)).toEqual([1, 2]);
    });

    it('returns nothing for a shape that carries no points at all', () => {
        expect(readSeries(undefined, 'speed')).toEqual([]);
        expect(readSeries({ points: 'nope' }, 'speed')).toEqual([]);
    });
});

describe('buildBzSparkline', () => {
    it('draws nothing at all when there is not enough to make a line', () => {
        expect(buildBzSparkline(blob('bz', [-4]))).toBeNull();
        expect(buildBzSparkline(undefined)).toBeNull();
    });

    it('picks out the current southward run and fills it to the zero line', () => {
        // Northward, then southward for the last three readings.
        const svg = buildBzSparkline(blob('bz', [3, 2, -1, -3, -5]));

        expect(svg?.querySelector('.aurora-spark-run')).not.toBeNull();
        expect(svg?.querySelector('.aurora-spark-history')).not.toBeNull();
        const area = svg?.querySelector('.aurora-spark-area');
        expect(area).not.toBeNull();
        // A closed shape, so it can be filled rather than just stroked.
        expect(area?.getAttribute('d')).toMatch(/Z$/);
    });

    it('leaves the line entirely muted when Bz is northward now, with nothing filled', () => {
        // No run means no claim to colour: the magenta says "southward", so
        // it must not appear while the field is pointing north.
        const svg = buildBzSparkline(blob('bz', [-5, -4, 2]));

        expect(svg?.querySelector('.aurora-spark-run')).toBeNull();
        expect(svg?.querySelector('.aurora-spark-area')).toBeNull();
        expect(svg?.querySelector('.aurora-spark-history')).not.toBeNull();
        expect(svg?.querySelector('.aurora-spark-dot--run')).toBeNull();
    });

    it('splits the line at the same boundary the caption counts from', () => {
        // The run starts at index 2 of 5, so the muted history must end
        // exactly where the magenta run begins -- one shared point, no gap
        // and no overlap.
        const svg = buildBzSparkline(blob('bz', [3, 2, -1, -3, -5]));
        const history = svg?.querySelector('.aurora-spark-history')?.getAttribute('d') ?? '';
        const run = svg?.querySelector('.aurora-spark-run')?.getAttribute('d') ?? '';

        const historyEnd = history.split(' ').pop() ?? '';
        const runStart = run.split(' ')[0] ?? '';
        expect(historyEnd.replace('L', '')).toBe(runStart.replace('M', ''));
    });

    it('keeps zero inside the drawn range even when every reading is southward', () => {
        // The chart is about the sign of Bz, so a zero line off the top of
        // the box would hide the very thing it exists to show.
        const svg = buildBzSparkline(blob('bz', [-9, -8, -7]));
        const zero = svg?.querySelector('.aurora-spark-zero');
        const y = Number(zero?.getAttribute('y1'));

        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(30);
    });

    it('puts a more negative reading lower on the chart than a less negative one', () => {
        const svg = buildBzSparkline(blob('bz', [-1, -9]));
        const commands = (svg?.querySelector('.aurora-spark-run')?.getAttribute('d') ?? '').split(' ');
        const first = commands[0] ?? '';
        const last = commands[commands.length - 1] ?? '';

        // y grows downward in SVG.
        expect(yOf(last)).toBeGreaterThan(yOf(first));
    });
});

describe('buildPlasmaSparkline', () => {
    it('draws a line with a dashed midpoint reference and an endpoint dot', () => {
        const svg = buildPlasmaSparkline(blob('speed', [400, 450, 500]), 'speed');

        expect(paths(svg)).toHaveLength(1);
        // The dash pattern itself is CSS's business; what the markup owes it
        // is the hook and a full-width reference line.
        const midline = svg?.querySelector('.aurora-spark-midline');
        expect(midline).not.toBeNull();
        expect(midline?.getAttribute('x1')).toBe('0');
        expect(midline?.getAttribute('x2')).toBe('170');
        expect(svg?.querySelector('.aurora-spark-dot')).not.toBeNull();
    });

    it('reads whichever series it was asked for', () => {
        const both = {
            points: [
                { time: '2026-09-07T15:00:00Z', speed: 400, density: 1 },
                { time: '2026-09-07T15:05:00Z', speed: 500, density: 9 },
            ],
        };
        const speed = buildPlasmaSparkline(both, 'speed');
        const density = buildPlasmaSparkline(both, 'density');

        expect(speed?.classList.contains('aurora-spark--speed')).toBe(true);
        expect(density?.classList.contains('aurora-spark--density')).toBe(true);
    });

    it('draws a flat series down the middle instead of dividing by zero', () => {
        const svg = buildPlasmaSparkline(blob('speed', [420, 420, 420]), 'speed');
        const commands = (svg?.querySelector('.aurora-spark-line')?.getAttribute('d') ?? '').split(' ');

        expect(commands.length).toBeGreaterThan(1);
        for (const command of commands) expect(yOf(command)).toBe(15);
    });

    it('draws nothing when the series is too short to be a line', () => {
        expect(buildPlasmaSparkline(blob('speed', [400]), 'speed')).toBeNull();
        expect(buildPlasmaSparkline({}, 'density')).toBeNull();
    });
});
