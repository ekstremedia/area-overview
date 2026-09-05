import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/fixtures/aurora.json' with { type: 'json' };
import { selectKpBars } from './kpBars.js';

describe('selectKpBars', () => {
    it('picks 3 past + now + 4 future = 8 bars from the real fixture', () => {
        const now = new Date(fixture.status.kpCurrent.time);
        const bars = selectKpBars(fixture.indices.kpHistory, fixture.status.kpCurrent.value, fixture.status.kpForecast, now);

        expect(bars).toHaveLength(8);
        expect(bars.filter((b) => b.kind === 'past')).toHaveLength(3);
        expect(bars.filter((b) => b.kind === 'now')).toHaveLength(1);
        expect(bars.filter((b) => b.kind === 'future')).toHaveLength(4);
        expect(bars[3]).toEqual({ value: fixture.status.kpCurrent.value, kind: 'now' });
    });

    it('orders past bars oldest-to-newest and future bars nearest-first', () => {
        const history = [
            { time: '2026-09-05T00:00:00Z', kp: 1 },
            { time: '2026-09-05T03:00:00Z', kp: 2 },
            { time: '2026-09-05T06:00:00Z', kp: 3 },
        ];
        const forecast = [
            { time: '2026-09-05T12:00:00Z', kp: 4 },
            { time: '2026-09-05T15:00:00Z', kp: 5 },
        ];
        const now = new Date('2026-09-05T09:00:00Z');

        const bars = selectKpBars(history, 3.5, forecast, now);
        expect(bars.map((b) => b.value)).toEqual([1, 2, 3, 3.5, 4, 5]);
    });
});
