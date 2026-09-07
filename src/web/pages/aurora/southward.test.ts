import { describe, expect, it } from 'vitest';
import { southwardRun } from './southward.js';

/** `mag.points` as the upstream serves it: oldest first, one point a minute. */
function mag(bzSeries: readonly number[]): unknown {
    const start = Date.parse('2026-09-07T15:00:00Z');
    return {
        points: bzSeries.map((bz, index) => ({ time: new Date(start + index * 60_000).toISOString(), bz })),
    };
}

describe('southwardRun', () => {
    it('returns nothing while Bz is northward, rather than a zero-length run', () => {
        // "0 minutes southward" would read as a fact about the aurora; the
        // absence of one is the honest rendering.
        expect(southwardRun(mag([-5, -4, 2.1]))).toBeNull();
    });

    it('treats exactly zero as not southward', () => {
        expect(southwardRun(mag([-5, -4, 0]))).toBeNull();
    });

    it('measures the current run back to the last northward reading', () => {
        // Five points, the last three southward: two minutes of gap
        // between the first and last of them.
        expect(southwardRun(mag([1, 2, -3, -4, -5]))).toEqual({ minutes: 2, atLeast: false });
    });

    it('flags a run that fills the whole window, since the real duration is unknowable from it', () => {
        // The upstream window is about an hour. A spell that reaches the
        // oldest reading has been going on for *at least* that long, and
        // the caller says "over" rather than inventing a precise figure.
        const run = southwardRun(mag([-3, -4, -5, -6]));
        expect(run).toEqual({ minutes: 3, atLeast: true });
    });

    it('never reports a zero-minute run for a single southward reading', () => {
        expect(southwardRun(mag([-4]))).toEqual({ minutes: 1, atLeast: true });
    });

    it('sorts by time rather than trusting the array order', () => {
        const points = [
            { time: '2026-09-07T15:02:00Z', bz: -5 },
            { time: '2026-09-07T15:00:00Z', bz: -3 },
            { time: '2026-09-07T15:01:00Z', bz: -4 },
        ];
        expect(southwardRun({ points })).toEqual({ minutes: 2, atLeast: true });
    });

    it('skips malformed points instead of trusting the unvalidated blob', () => {
        const points = [
            { time: 'not a date', bz: -9 },
            { time: '2026-09-07T15:00:00Z', bz: 'cold' },
            null,
            { time: '2026-09-07T15:01:00Z', bz: -4 },
            { time: '2026-09-07T15:02:00Z', bz: -5 },
        ];
        expect(southwardRun({ points })).toEqual({ minutes: 1, atLeast: true });
    });

    it('returns nothing for a shape that carries no points at all', () => {
        expect(southwardRun(undefined)).toBeNull();
        expect(southwardRun(null)).toBeNull();
        expect(southwardRun({})).toBeNull();
        expect(southwardRun({ points: 'nope' })).toBeNull();
        expect(southwardRun({ points: [] })).toBeNull();
    });
});
