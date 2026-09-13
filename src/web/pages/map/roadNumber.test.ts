import { describe, expect, it } from 'vitest';
import { formatRoadNumber } from './roadNumber.js';

describe('formatRoadNumber', () => {
    it('leaves a European route as upstream writes it', () => {
        // "Ev. 10" is not a thing anyone says or signs.
        expect(formatRoadNumber('E10')).toBe('E10');
        expect(formatRoadNumber('E6')).toBe('E6');
    });

    it('expands the road-class letters into their everyday abbreviation', () => {
        expect(formatRoadNumber('R85')).toBe('Rv. 85');
        expect(formatRoadNumber('F82')).toBe('Fv. 82');
        expect(formatRoadNumber('F7542')).toBe('Fv. 7542');
        expect(formatRoadNumber('K1234')).toBe('Kv. 1234');
    });

    it('treats a missing or blank road number as absent', () => {
        // Six of 2665 live records carry no `ROAD_NUMBER` at all -- the
        // popup then simply has no road line, rather than an empty one.
        expect(formatRoadNumber(null)).toBeNull();
        expect(formatRoadNumber('   ')).toBeNull();
    });

    it('passes an unrecognised shape through rather than dropping or decorating it', () => {
        expect(formatRoadNumber('Rv 85 arm')).toBe('Rv 85 arm');
        expect(formatRoadNumber(' E10 ')).toBe('E10');
    });
});
