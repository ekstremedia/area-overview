import { describe, expect, it } from 'vitest';
import {
    ageMs,
    diffGlyphs,
    planeLocalPoints,
    rotatedPlanePoints,
    opacityForAge,
    rotatePoint,
    rotatedTrianglePoints,
    triangleLocalPoints,
    visibleGlyphs,
    type GlyphDescriptor,
} from './glyphs.js';

function glyph(overrides: Partial<GlyphDescriptor<string>> = {}): GlyphDescriptor<string> {
    return { id: 'a', lat: 68.7, lng: 15.4, heading: 45, timestamp: '2026-09-05T12:00:00Z', data: 'a', ...overrides };
}

describe('diffGlyphs', () => {
    it('adds every descriptor when there is no previous state', () => {
        const a = glyph();
        expect(diffGlyphs(new Map(), [a])).toEqual({ toAdd: [a], toUpdate: [], toRemove: [] });
    });

    it('produces an empty diff when nothing changed', () => {
        const a = glyph();
        const previous = new Map([[a.id, a]]);
        expect(diffGlyphs(previous, [a])).toEqual({ toAdd: [], toUpdate: [], toRemove: [] });
    });

    it('reports a moved glyph (changed lat/lng) as an update, not add+remove', () => {
        const a = glyph();
        const moved = glyph({ lat: 69.0 });
        const previous = new Map([[a.id, a]]);
        expect(diffGlyphs(previous, [moved])).toEqual({ toAdd: [], toUpdate: [moved], toRemove: [] });
    });

    it('reports a changed heading as an update', () => {
        const a = glyph();
        const turned = glyph({ heading: 90 });
        const previous = new Map([[a.id, a]]);
        expect(diffGlyphs(previous, [turned])).toEqual({ toAdd: [], toUpdate: [turned], toRemove: [] });
    });

    it('reports a glyph missing from the next set as a removal', () => {
        const a = glyph({ id: 'a' });
        const b = glyph({ id: 'b' });
        const previous = new Map([
            ['a', a],
            ['b', b],
        ]);
        expect(diffGlyphs(previous, [a])).toEqual({ toAdd: [], toUpdate: [], toRemove: ['b'] });
    });

    it('does not treat a changed data payload alone (same lat/lng/heading/timestamp) as an update', () => {
        // Mirrors markers.ts's own diffing philosophy: identity is
        // lat/lng/heading/timestamp, not object reference -- a fresh
        // fetch that changed nothing meaningful must not thrash the map.
        const a = glyph({ data: 'first' });
        const sameShapeNewRef = glyph({ data: 'first-but-different-reference' });
        const previous = new Map([[a.id, a]]);
        expect(diffGlyphs(previous, [sameShapeNewRef])).toEqual({ toAdd: [], toUpdate: [], toRemove: [] });
    });
});

describe('ageMs / opacityForAge', () => {
    const now = new Date('2026-09-05T12:30:00Z');

    it('computes age in milliseconds', () => {
        expect(ageMs('2026-09-05T12:00:00Z', now)).toBe(30 * 60_000);
    });

    it('is fully opaque well within maxAgeMinutes', () => {
        expect(opacityForAge(60_000, 30)).toBe(1);
    });

    it('is exactly opaque just under half of maxAgeMinutes', () => {
        expect(opacityForAge(15 * 60_000 - 1, 30)).toBe(1);
    });

    it('dims to 0.42 at and beyond half of maxAgeMinutes', () => {
        expect(opacityForAge(15 * 60_000, 30)).toBe(0.42);
        expect(opacityForAge(20 * 60_000, 30)).toBe(0.42);
    });

    it('is removed (null) at and beyond the full maxAgeMinutes', () => {
        expect(opacityForAge(30 * 60_000, 30)).toBeNull();
        expect(opacityForAge(60 * 60_000, 30)).toBeNull();
    });
});

describe('visibleGlyphs', () => {
    const now = new Date('2026-09-05T12:30:00Z');

    it('drops items older than maxAgeMinutes and keeps the rest with their opacity', () => {
        const fresh = glyph({ id: 'fresh', timestamp: '2026-09-05T12:29:00Z' }); // 1 min old
        const aged = glyph({ id: 'aged', timestamp: '2026-09-05T12:16:00Z' }); // 14 min old, half of 28 would dim... use maxAge=20
        const expired = glyph({ id: 'expired', timestamp: '2026-09-05T11:00:00Z' }); // 90 min old

        const result = visibleGlyphs([fresh, aged, expired], 20, now);

        expect(result.map((r) => r.descriptor.id)).toEqual(['fresh', 'aged']);
        expect(result.find((r) => r.descriptor.id === 'fresh')?.opacity).toBe(1);
        expect(result.find((r) => r.descriptor.id === 'aged')?.opacity).toBe(0.42);
    });
});

describe('triangle geometry', () => {
    it('places the apex straight up (negative y) and the base below it, centered', () => {
        const [apex, left, right] = triangleLocalPoints(14, 19);
        expect(apex).toEqual({ x: 0, y: -9.5 });
        expect(left.y).toBe(9.5);
        expect(right.y).toBe(9.5);
        expect(left.x).toBe(-7);
        expect(right.x).toBe(7);
    });

    it('rotatePoint leaves a point unchanged at heading 0', () => {
        expect(rotatePoint({ x: 0, y: -10 }, 0)).toEqual({ x: 0, y: -10 });
    });

    it('rotatePoint at heading 90 turns "up" into "right"', () => {
        const rotated = rotatePoint({ x: 0, y: -10 }, 90);
        expect(rotated.x).toBeCloseTo(10);
        expect(rotated.y).toBeCloseTo(0);
    });

    it('rotatePoint at heading 180 turns "up" into "down"', () => {
        const rotated = rotatePoint({ x: 0, y: -10 }, 180);
        expect(rotated.x).toBeCloseTo(0);
        expect(rotated.y).toBeCloseTo(10);
    });

    it('rotatePoint at heading 270 turns "up" into "left"', () => {
        const rotated = rotatePoint({ x: 0, y: -10 }, 270);
        expect(rotated.x).toBeCloseTo(-10);
        expect(rotated.y).toBeCloseTo(0);
    });

    it('rotatedTrianglePoints rotates all three corners consistently', () => {
        const [apex, left, right] = rotatedTrianglePoints(14, 19, 90);
        expect(apex.x).toBeCloseTo(9.5);
        expect(apex.y).toBeCloseTo(0);
        expect(left.x).toBeCloseTo(-9.5);
        expect(left.y).toBeCloseTo(-7);
        expect(right.x).toBeCloseTo(-9.5);
        expect(right.y).toBeCloseTo(7);
    });
});

describe('rotatedPlanePoints', () => {
    it('draws a closed outline wider than it is deep, centred on the origin', () => {
        const points = planeLocalPoints(24, 24);

        // A plane silhouette, not a triangle: many more vertices, and the
        // wings reach further across than the nose reaches forward.
        expect(points.length).toBeGreaterThan(10);
        const maxX = Math.max(...points.map((p) => Math.abs(p.x)));
        const maxY = Math.max(...points.map((p) => Math.abs(p.y)));
        expect(maxX).toBeCloseTo(12);
        expect(maxY).toBeCloseTo(12);

        // Symmetric about the fuselage, or it reads as a damaged aircraft.
        for (const point of points) {
            expect(points.some((other) => Math.abs(other.x + point.x) < 1e-9 && Math.abs(other.y - point.y) < 1e-9)).toBe(true);
        }
    });

    it('points the nose along the heading', () => {
        const nose = { x: 0, y: -12 }; // unrotated: straight up

        const east = rotatedPlanePoints(24, 24, 90);
        // Rotated 90 degrees clockwise, the nose points right (+x).
        expect(east[0]?.x).toBeCloseTo(12);
        expect(east[0]?.y).toBeCloseTo(0);

        const north = rotatedPlanePoints(24, 24, 0);
        expect(north[0]?.x).toBeCloseTo(nose.x);
        expect(north[0]?.y).toBeCloseTo(nose.y);
    });

    it('scales with the bounding box, so the hit-target copy keeps the same shape', () => {
        const small = planeLocalPoints(10, 10);
        const large = planeLocalPoints(30, 30);

        small.forEach((point, index) => {
            expect(large[index]?.x).toBeCloseTo(point.x * 3);
            expect(large[index]?.y).toBeCloseTo(point.y * 3);
        });
    });
});
