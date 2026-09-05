import { describe, expect, it } from 'vitest';
import { ACTIVE_THRESHOLD_GW, STORM_THRESHOLD_GW, activityBandForHemisphericPower } from './activityBand.js';

describe('activityBandForHemisphericPower', () => {
    it('is "quiet" below the active threshold (< 20 GW)', () => {
        expect(activityBandForHemisphericPower(0)).toBe('quiet');
        expect(activityBandForHemisphericPower(19.9)).toBe('quiet');
    });

    it('is "active" from the active threshold up to and including the storm threshold (20-50 GW)', () => {
        expect(activityBandForHemisphericPower(ACTIVE_THRESHOLD_GW)).toBe('active');
        expect(activityBandForHemisphericPower(35)).toBe('active');
        expect(activityBandForHemisphericPower(STORM_THRESHOLD_GW)).toBe('active');
    });

    it('is "storm" above the storm threshold (> 50 GW)', () => {
        expect(activityBandForHemisphericPower(50.1)).toBe('storm');
        expect(activityBandForHemisphericPower(62)).toBe('storm');
    });
});
