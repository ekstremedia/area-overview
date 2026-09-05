import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/fixtures/aurora.json' with { type: 'json' };
import { firstAlertSummary, hemisphericPowerNorthGw, scaleGLevel, solarWindStats } from './extract.js';

describe('aurora extract helpers', () => {
    it('reads the real fixture correctly', () => {
        expect(hemisphericPowerNorthGw(fixture.status.hemisphericPower)).toBe(29);
        expect(scaleGLevel(fixture.status.scales)).toBe('G0');
        expect(solarWindStats(fixture.solarWind.current)).toEqual({ bz: -1.09, speed: 334, density: 3.51 });
        expect(firstAlertSummary(fixture.alerts.alerts)).toBe('Issue Time: 2026 Sep 04 2007 UTC');
    });

    it('returns null instead of throwing on an unexpected shape', () => {
        expect(hemisphericPowerNorthGw({})).toBeNull();
        expect(scaleGLevel({})).toBeNull();
        expect(solarWindStats({})).toBeNull();
        expect(firstAlertSummary([])).toBeNull();
        expect(firstAlertSummary([{ notSummary: 'x' }])).toBeNull();
    });
});
