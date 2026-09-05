import { describe, expect, it } from 'vitest';
import { isWithinNightWindow } from './night-schedule.js';

function at(hhmm: string): Date {
    const [hoursPart, minutesPart] = hhmm.split(':');
    const date = new Date('2026-01-01T00:00:00');
    date.setHours(Number(hoursPart), Number(minutesPart), 0, 0);
    return date;
}

describe('isWithinNightWindow', () => {
    it('is active inside a same-day window', () => {
        expect(isWithinNightWindow('09:00', '17:00', at('12:00'))).toBe(true);
        expect(isWithinNightWindow('09:00', '17:00', at('08:59'))).toBe(false);
        expect(isWithinNightWindow('09:00', '17:00', at('17:00'))).toBe(false); // `to` is exclusive
    });

    it('is active inside a window that wraps past midnight', () => {
        expect(isWithinNightWindow('22:00', '02:00', at('23:30'))).toBe(true);
        expect(isWithinNightWindow('22:00', '02:00', at('01:00'))).toBe(true);
        expect(isWithinNightWindow('22:00', '02:00', at('10:00'))).toBe(false);
    });

    it('is active right at the wrap boundary but not right after `to`', () => {
        expect(isWithinNightWindow('22:00', '02:00', at('22:00'))).toBe(true);
        expect(isWithinNightWindow('22:00', '02:00', at('02:00'))).toBe(false);
    });

    it('treats a zero-length window (from === to) as never active', () => {
        expect(isWithinNightWindow('06:00', '06:00', at('06:00'))).toBe(false);
        expect(isWithinNightWindow('06:00', '06:00', at('12:00'))).toBe(false);
    });
});
