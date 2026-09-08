/**
 * The dead-reckoning maths the glyph layer animates with. Pure, so the
 * numbers can be checked against figures a navigator would recognise --
 * a knot is a nautical mile an hour, and a nautical mile of latitude is a
 * minute of arc.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PROJECTION_MS, projectPosition } from './motion.js';

/** 60 knots is a nautical mile a minute, so this is exactly one nautical mile of travel -- and it is inside `MAX_PROJECTION_MS`. */
const ONE_NM_AT_60KT_MS = 60_000;

describe('projectPosition', () => {
    it('covers a minute of latitude going north at a mile a minute', () => {
        // A nautical mile *is* a minute of arc, by definition.
        const next = projectPosition({ lat: 68, lng: 15 }, { speedKt: 60, courseDeg: 0 }, ONE_NM_AT_60KT_MS);

        expect(next.lat).toBeCloseTo(68 + 1 / 60, 4);
        expect(next.lng).toBeCloseTo(15, 6);
    });

    it('crosses more longitude than latitude for the same distance this far north', () => {
        // At 68°N a degree of longitude is cos(68) ≈ 0.375 of one at the
        // equator, so the same nautical mile east covers ~2.7x the degrees.
        const next = projectPosition({ lat: 68, lng: 15 }, { speedKt: 60, courseDeg: 90 }, ONE_NM_AT_60KT_MS);

        expect(next.lat).toBeCloseTo(68, 6);
        // To three decimals: the flat-earth model measures a minute of
        // latitude as 1855m against the nautical mile's 1852m, a 0.2%
        // difference that is metres over the seconds this ever projects.
        expect(next.lng).toBeCloseTo(15 + 1 / 60 / Math.cos((68 * Math.PI) / 180), 3);
    });

    it('carries a ship a plausible distance over one poll interval', () => {
        // 10 knots for 15 seconds is 77 metres -- 0.0007° of latitude.
        const next = projectPosition({ lat: 68.7, lng: 15.4 }, { speedKt: 10, courseDeg: 0 }, 15_000);

        expect((next.lat - 68.7) * 111_320).toBeCloseTo(77, 0);
    });

    it('falls back to the last measured position once a fix is old enough to be a guess', () => {
        // Not "frozen 90 seconds ahead": an aircraft that stopped
        // reporting may have turned or landed, and the only position
        // anyone actually measured is the one to show.
        const at = { lat: 68, lng: 15 };

        expect(projectPosition(at, { speedKt: 240, courseDeg: 0 }, MAX_PROJECTION_MS + 1)).toEqual(at);
        expect(projectPosition(at, { speedKt: 240, courseDeg: 0 }, MAX_PROJECTION_MS).lat).toBeGreaterThan(68); // still projected right up to the cap
    });

    it('leaves anything it cannot honestly project exactly where it was', () => {
        const at = { lat: 68.7, lng: 15.4 };

        expect(projectPosition(at, null, 10_000)).toEqual(at); // no velocity reported
        expect(projectPosition(at, { speedKt: 0, courseDeg: 90 }, 10_000)).toEqual(at); // moored
        expect(projectPosition(at, { speedKt: Number.NaN, courseDeg: 90 }, 10_000)).toEqual(at);
        expect(projectPosition(at, { speedKt: 10, courseDeg: Number.NaN }, 10_000)).toEqual(at);
        expect(projectPosition(at, { speedKt: 10, courseDeg: 90 }, -5_000)).toEqual(at); // a fix stamped in the future
        expect(projectPosition(at, { speedKt: 10, courseDeg: 90 }, 0)).toEqual(at);
    });

    it('refuses to project at the pole rather than flinging the glyph across the map', () => {
        const atPole = { lat: 90, lng: 15 };

        expect(projectPosition(atPole, { speedKt: 10, courseDeg: 90 }, 10_000)).toEqual(atPole);
    });
});
