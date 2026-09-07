/**
 * `trails.ts`'s pure history/fade logic. `trailLayer.ts`'s Leaflet half is
 * covered separately; everything here needs no map.
 */
import { describe, expect, it } from 'vitest';
import { appendTrailPoint, trailSegments, type TrailPoint } from './trails.js';

/** `now` is explicit per call: the age cutoff is measured against wall-clock time, not against the incoming fix's own timestamp. */
function opts(now: number) {
    return { maxPoints: 4, maxAgeMs: 60_000, now };
}

function point(lat: number, at: number): TrailPoint {
    return { lat, lng: 15, at };
}

describe('appendTrailPoint', () => {
    it('appends a new position without mutating the input', () => {
        const points = [point(68.1, 1_000)];
        const next = appendTrailPoint(points, point(68.2, 2_000), opts(2_000));

        expect(next).toHaveLength(2);
        expect(next[1]?.lat).toBe(68.2);
        expect(points).toHaveLength(1); // untouched
    });

    it('drops a repeat of the newest position -- a moored ship must not fill its own history with one spot', () => {
        const points = [point(68.1, 1_000), point(68.2, 2_000)];

        const next = appendTrailPoint(points, point(68.2, 3_000), opts(3_000));

        expect(next).toHaveLength(2);
        expect(next[1]?.at).toBe(2_000); // the original fix kept, not the restated one
    });

    it('drops a re-served fix at the same timestamp even if the coordinates differ', () => {
        const points = [point(68.1, 1_000)];

        const next = appendTrailPoint(points, point(68.9, 1_000), opts(1_000));

        expect(next).toHaveLength(1);
    });

    it('keeps only the newest maxPoints positions', () => {
        let points: TrailPoint[] = [];
        for (let i = 1; i <= 6; i++) points = appendTrailPoint(points, point(68 + i / 100, i * 1_000), opts(i * 1_000));

        expect(points).toHaveLength(4);
        expect(points.map((p) => p.at)).toEqual([3_000, 4_000, 5_000, 6_000]);
    });

    it('drops positions older than maxAgeMs, so a returning vessel gets no line ruled across the gap', () => {
        const points = [point(68.1, 1_000), point(68.2, 2_000)];

        // Back after a long absence: both earlier fixes are now beyond the
        // 60s window and must not survive to be drawn to.
        const next = appendTrailPoint(points, point(68.5, 500_000), opts(500_000));

        expect(next).toHaveLength(1);
        expect(next[0]?.at).toBe(500_000);
    });
});

describe('appendTrailPoint -- ageing against wall-clock time', () => {
    it('ages history out even while upstream keeps restating one stale fix', () => {
        // A moored vessel whose fix stopped advancing: every poll re-serves
        // `at: 2_000`. A cutoff derived from that timestamp would never move,
        // so the trail would sit on screen forever.
        const points = [point(68.1, 1_000), point(68.2, 2_000)];

        const next = appendTrailPoint(points, point(68.2, 2_000), opts(200_000));

        expect(next).toHaveLength(0);
    });

    it('returns the identical array when nothing changed, and a different one when ageing dropped a point', () => {
        const points = [point(68.1, 1_000), point(68.2, 2_000)];

        // Repeat fix, nothing old enough to drop: caller must be able to see
        // "no change" and skip redrawing.
        expect(appendTrailPoint(points, point(68.2, 2_000), opts(2_500))).toBe(points);

        // Same repeat fix, but now the oldest point has aged out. The newest
        // timestamp is untouched, so only identity reveals that the drawn
        // trail is now wrong.
        const aged = appendTrailPoint(points, point(68.2, 2_000), opts(61_500));
        expect(aged).not.toBe(points);
        expect(aged).toHaveLength(1);
        expect(aged[0]?.at).toBe(2_000);
    });
});

describe('appendTrailPoint -- a fix that arrives already stale', () => {
    it('refuses an incoming point older than the window, rather than seating it at the newest end', () => {
        // The layers above age vessels on looser thresholds than this
        // history keeps, so a vessel still worth drawing can report a
        // position older than the trail window. Appending it would put an
        // out-of-window point where ageing never looks again.
        const points = [point(68.1, 100_000), point(68.2, 110_000)];

        const next = appendTrailPoint(points, point(68.9, 1_000), opts(120_000));

        expect(next).toBe(points); // nothing changed, so no redraw either
        expect(next.map((p) => p.at)).toEqual([100_000, 110_000]);
    });

    it('still ages the existing history when the incoming point is refused', () => {
        const points = [point(68.1, 1_000), point(68.2, 110_000)];

        // Cutoff is 120_000 - 60_000: the first point goes, and the stale
        // incoming one is not taken in its place.
        const next = appendTrailPoint(points, point(68.9, 2_000), opts(120_000));

        expect(next).not.toBe(points);
        expect(next.map((p) => p.at)).toEqual([110_000]);
    });
});

describe('appendTrailPoint -- after a vessel has sat still', () => {
    it('takes a fresh fix at the same spot once the earlier one has expired, so the next move can be drawn', () => {
        // A vessel stationary long enough for its only point to age out.
        // Judging "is this a repeat?" against the expired point would
        // reject the fresh fix and leave nothing behind, so the next
        // movement would have no prior point to draw a segment from.
        const stale = [point(68.1, 1_000)];

        const refreshed = appendTrailPoint(stale, point(68.1, 100_000), opts(100_000));
        expect(refreshed.map((p) => p.at)).toEqual([100_000]);

        const moved = appendTrailPoint(refreshed, point(68.2, 110_000), opts(110_000));
        expect(moved.map((p) => p.at)).toEqual([100_000, 110_000]);
        expect(trailSegments(moved, { newestOpacity: 0.6, oldestOpacity: 0.1 })).toHaveLength(1);
    });
});

describe('trailSegments', () => {
    const fade = { newestOpacity: 0.6, oldestOpacity: 0.1 };

    it('yields nothing to draw for an empty or single-point history', () => {
        expect(trailSegments([], fade)).toEqual([]);
        expect(trailSegments([point(68.1, 1_000)], fade)).toEqual([]);
    });

    it('draws a lone segment at full trail opacity -- with no ramp to show, the one segment is the freshest', () => {
        const segments = trailSegments([point(68.1, 1_000), point(68.2, 2_000)], fade);

        expect(segments).toHaveLength(1);
        expect(segments[0]?.opacity).toBe(0.6);
    });

    it('ramps opacity from oldest to newest, which is what points the tail back the way the vessel came', () => {
        const points = [point(68.1, 1_000), point(68.2, 2_000), point(68.3, 3_000), point(68.4, 4_000)];

        const segments = trailSegments(points, fade);

        expect(segments).toHaveLength(3);
        expect(segments.map((s) => s.opacity)).toEqual([0.1, 0.35, 0.6]);
        // Oldest first, and each segment joins consecutive fixes.
        expect(segments[0]?.from.at).toBe(1_000);
        expect(segments[0]?.to.at).toBe(2_000);
        expect(segments[2]?.to.at).toBe(4_000);
    });

    it('never exceeds the configured bounds, however long the history', () => {
        const points = Array.from({ length: 10 }, (_, i) => point(68 + i / 100, i * 1_000));

        const opacities = trailSegments(points, fade).map((s) => s.opacity);

        expect(Math.min(...opacities)).toBe(0.1);
        expect(Math.max(...opacities)).toBe(0.6);
    });
});
