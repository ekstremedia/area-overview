import { describe, expect, it } from 'vitest';
import situationsFixture from './fixtures/situations-vesteralen.json' with { type: 'json' };
import { simplifyLine, type LinePoint } from './simplify.js';

/** The fixture's 421-point E10 line, swapped into Leaflet's `[lat, lng]` order the way `situations.ts` hands it over. */
function longFixtureLine(): LinePoint[] {
    const feature = situationsFixture.features.find((candidate) => candidate.properties.SITUATION_ID === 'NPRA_1010');
    const geometry = feature?.geometry;
    if (geometry?.type !== 'LineString') throw new Error('the long-line fixture is missing');
    return (geometry.coordinates as [number, number][]).map(([lng, lat]): LinePoint => [lat, lng]);
}

describe('simplifyLine', () => {
    it('leaves a two-point line alone', () => {
        expect(
            simplifyLine([
                [68.1, 15.1],
                [68.2, 15.2],
            ]),
        ).toEqual([
            [68.1, 15.1],
            [68.2, 15.2],
        ]);
    });

    it('drops collinear points and keeps both endpoints', () => {
        const simplified = simplifyLine([
            [68.0, 15.0],
            [68.1, 15.1],
            [68.2, 15.2],
            [68.3, 15.3],
        ]);

        expect(simplified).toEqual([
            [68.0, 15.0],
            [68.3, 15.3],
        ]);
    });

    it('keeps a point that genuinely departs from the straight line', () => {
        // 0.01 degrees off the chord is a kilometre -- a real bend in the
        // road, not survey noise.
        const simplified = simplifyLine([
            [68.0, 15.0],
            [68.01, 15.1],
            [68.0, 15.2],
        ]);

        expect(simplified).toHaveLength(3);
    });

    it('rounds to five decimals', () => {
        const simplified = simplifyLine([
            [68.1234567, 15.7654321],
            [68.2234567, 15.8654321],
        ]);

        expect(simplified).toEqual([
            [68.12346, 15.76543],
            [68.22346, 15.86543],
        ]);
    });

    it('collapses a line whose points all round onto each other', () => {
        const simplified = simplifyLine([
            [68.100001, 15.100001],
            [68.100002, 15.100002],
            [68.100003, 15.100003],
        ]);

        expect(simplified).toEqual([[68.1, 15.1]]);
    });

    it('cuts the 421-point fixture line to well under sixty points, endpoints intact', () => {
        const line = longFixtureLine();

        const simplified = simplifyLine(line);

        expect(line.length).toBe(421);
        expect(simplified.length).toBeLessThan(60);
        expect(simplified.length).toBeGreaterThan(2);
        expect(simplified[0]).toEqual([Number(line[0]?.[0].toFixed(5)), Number(line[0]?.[1].toFixed(5))]);
        expect(simplified[simplified.length - 1]).toEqual([Number(line[420]?.[0].toFixed(5)), Number(line[420]?.[1].toFixed(5))]);
    });

    it('honours a tolerance the caller chooses', () => {
        const line = longFixtureLine();

        // A tolerance an order of magnitude looser keeps strictly fewer
        // points -- the knob works in the direction it claims to.
        expect(simplifyLine(line, 0.002).length).toBeLessThan(simplifyLine(line).length);
    });
});
