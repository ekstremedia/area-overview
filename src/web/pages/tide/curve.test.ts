import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/fixtures/tide.json' with { type: 'json' };
import { TideSchema } from '../../../shared/schemas/tide.js';
import { tideCurve, tideCurveTicks } from './curve.js';

const tide = TideSchema.parse(fixture);

describe('tideCurve', () => {
    it('draws one prediction line/area with a point for every timeseries entry', () => {
        const now = new Date(tide.serverNow);
        const svg = tideCurve(tide.timeseries, now, tide.extremes);

        const line = svg.querySelector('.tide-curve-prediction-line');
        expect(line).not.toBeNull();
        const d = line?.getAttribute('d') ?? '';
        // One `M` (move-to) plus one `L` (line-to) per remaining point.
        const commandCount = (d.match(/[ML]/g) ?? []).length;
        expect(commandCount).toBe(tide.timeseries.length);

        expect(svg.querySelector('.tide-curve-prediction-area')).not.toBeNull();
    });

    it('draws a now-marker positioned within the chart window', () => {
        const now = new Date(tide.serverNow);
        const svg = tideCurve(tide.timeseries, now, tide.extremes);

        const nowLine = svg.querySelector('.tide-curve-now');
        expect(nowLine).not.toBeNull();
        const x = Number(nowLine?.getAttribute('x1'));
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(960);
    });

    it('is a pure function: identical input twice produces an identical SVG', () => {
        const now = new Date(tide.serverNow);
        const first = tideCurve(tide.timeseries, now, tide.extremes);
        const second = tideCurve(tide.timeseries, now, tide.extremes);

        expect(first.outerHTML).toBe(second.outerHTML);
    });

    it('sets viewBox and preserveAspectRatio for fluid width', () => {
        const svg = tideCurve(tide.timeseries, new Date(tide.serverNow), tide.extremes);
        expect(svg.getAttribute('viewBox')).toBe('0 0 960 200');
        expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    });

    it('handles an empty series without throwing', () => {
        const svg = tideCurve([], new Date(), []);
        expect(svg.querySelector('.tide-curve-prediction-line')).toBeNull();
    });
});

describe('tideCurveTicks', () => {
    const series = [
        { time: '2026-09-07T00:00:00Z', value: -12, type: 'prediction' },
        { time: '2026-09-07T06:00:00Z', value: 110, type: 'prediction' },
        { time: '2026-09-07T12:00:00Z', value: 228, type: 'prediction' },
        { time: '2026-09-07T18:00:00Z', value: 40, type: 'prediction' },
    ];

    it("labels the scale in round values inside the day's range", () => {
        const ticks = tideCurveTicks(series, []);

        expect(ticks.length).toBeGreaterThan(1);
        for (const tick of ticks) {
            expect(tick.value).toBeGreaterThanOrEqual(-12);
            expect(tick.value).toBeLessThanOrEqual(228);
            // Positioned as a percentage down the plotted area.
            expect(tick.topPercent).toBeGreaterThanOrEqual(0);
            expect(tick.topPercent).toBeLessThanOrEqual(100);
        }
        // Round numbers, not raw samples.
        for (const tick of ticks) expect(Math.abs(tick.value % 10)).toBe(0);
    });

    it('puts a higher value further up the chart than a lower one', () => {
        const ticks = tideCurveTicks(series, []);
        const sorted = [...ticks].sort((a, b) => a.value - b.value);

        // y grows downward in SVG, so the smallest value has the largest
        // `topPercent`.
        const lowest = sorted[0];
        const highest = sorted[sorted.length - 1];
        if (!lowest || !highest) throw new Error('expected at least two ticks');
        expect(lowest.topPercent).toBeGreaterThan(highest.topPercent);
    });

    it('adapts the step to the range, so a barely-moving neap still gets labels', () => {
        const flat = [
            { time: '2026-09-07T00:00:00Z', value: 98, type: 'prediction' },
            { time: '2026-09-07T06:00:00Z', value: 122, type: 'prediction' },
        ];

        expect(tideCurveTicks(flat, []).length).toBeGreaterThan(1);
    });

    it('returns nothing to label when there is no range or no series at all', () => {
        expect(tideCurveTicks([], [])).toEqual([]);
        expect(tideCurveTicks([{ time: '2026-09-07T00:00:00Z', value: 50, type: 'prediction' }], [])).toEqual([]);
    });
});
