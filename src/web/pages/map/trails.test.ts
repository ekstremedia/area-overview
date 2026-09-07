/**
 * `trails.ts`'s pure history/fade logic. `trailLayer.ts`'s Leaflet half is
 * covered separately; everything here needs no map.
 */
import { describe, expect, it } from 'vitest';
import { appendTrailPoint, trailSegments, type TrailPoint } from './trails.js';

const OPTIONS = { maxPoints: 4, maxAgeMs: 60_000 };

function point(lat: number, at: number): TrailPoint {
    return { lat, lng: 15, at };
}

describe('appendTrailPoint', () => {
    it('appends a new position without mutating the input', () => {
        const points = [point(68.1, 1_000)];
        const next = appendTrailPoint(points, point(68.2, 2_000), OPTIONS);

        expect(next).toHaveLength(2);
        expect(next[1]?.lat).toBe(68.2);
        expect(points).toHaveLength(1); // untouched
    });

    it('drops a repeat of the newest position -- a moored ship must not fill its own history with one spot', () => {
        const points = [point(68.1, 1_000), point(68.2, 2_000)];

        const next = appendTrailPoint(points, point(68.2, 3_000), OPTIONS);

        expect(next).toHaveLength(2);
        expect(next[1]?.at).toBe(2_000); // the original fix kept, not the restated one
    });

    it('drops a re-served fix at the same timestamp even if the coordinates differ', () => {
        const points = [point(68.1, 1_000)];

        const next = appendTrailPoint(points, point(68.9, 1_000), OPTIONS);

        expect(next).toHaveLength(1);
    });

    it('keeps only the newest maxPoints positions', () => {
        let points: TrailPoint[] = [];
        for (let i = 1; i <= 6; i++) points = appendTrailPoint(points, point(68 + i / 100, i * 1_000), OPTIONS);

        expect(points).toHaveLength(4);
        expect(points.map((p) => p.at)).toEqual([3_000, 4_000, 5_000, 6_000]);
    });

    it('drops positions older than maxAgeMs, so a returning vessel gets no line ruled across the gap', () => {
        const points = [point(68.1, 1_000), point(68.2, 2_000)];

        // Back after a long absence: both earlier fixes are now beyond the
        // 60s window and must not survive to be drawn to.
        const next = appendTrailPoint(points, point(68.5, 500_000), OPTIONS);

        expect(next).toHaveLength(1);
        expect(next[0]?.at).toBe(500_000);
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
