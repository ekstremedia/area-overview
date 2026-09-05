import { describe, expect, it } from 'vitest';
import { cameraCountLabel } from './cameraCount.js';

describe('cameraCountLabel', () => {
    it('spells out counts from zero through ten', () => {
        expect(cameraCountLabel(0)).toBe('Ingen kameraer');
        expect(cameraCountLabel(1)).toBe('Ett kamera');
        expect(cameraCountLabel(2)).toBe('To kameraer');
        expect(cameraCountLabel(10)).toBe('Ti kameraer');
    });

    it('falls back to a numeral beyond ten', () => {
        expect(cameraCountLabel(11)).toBe('11 kameraer');
        expect(cameraCountLabel(25)).toBe('25 kameraer');
    });
});
