import { describe, expect, it } from 'vitest';
import { positionLabel } from './position-label.js';

const format = (value: number): string => String(value);

describe('positionLabel', () => {
    it('uses a real place name when the payload has one', () => {
        expect(positionLabel({ name: 'Oslo', point: { lat: 59.91, lng: 10.75 }, formatCoordinate: format })).toBe('Oslo');
    });

    it("never shows the upstream's own 'Custom Location' sentinel", () => {
        // An internal marker, in English, that must not reach a Norwegian
        // kiosk. It is what weather returns for any coordinate request.
        expect(positionLabel({ name: 'Custom Location', point: { lat: 59.91, lng: 10.75 }, formatCoordinate: format })).toBe('59.91, 10.75');
    });

    it('falls back to coordinates for an empty or missing name', () => {
        expect(positionLabel({ name: '', point: { lat: 59.91, lng: 10.75 }, formatCoordinate: format })).toBe('59.91, 10.75');
        expect(positionLabel({ name: '   ', point: { lat: 59.91, lng: 10.75 }, formatCoordinate: format })).toBe('59.91, 10.75');
        expect(positionLabel({ point: { lat: 59.91, lng: 10.75 }, formatCoordinate: format })).toBe('59.91, 10.75');
    });

    it('formats coordinates through the caller, so decimal separators follow the language', () => {
        const norwegian = (value: number): string => String(value).replace('.', ',');

        expect(positionLabel({ point: { lat: 59.91, lng: 10.75 }, formatCoordinate: norwegian })).toBe('59,91, 10,75');
    });

    it('says nothing at all for the home position', () => {
        expect(positionLabel({ point: null, formatCoordinate: format })).toBe('');
    });

    it('trims a padded name rather than rendering the padding', () => {
        expect(positionLabel({ name: '  Oslo  ', point: { lat: 59.91, lng: 10.75 }, formatCoordinate: format })).toBe('Oslo');
    });
});
