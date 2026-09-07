import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/fixtures/tide.json' with { type: 'json' };
import { TideSchema } from '../../../shared/schemas/tide.js';
import { tideCurve } from './curve.js';

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
