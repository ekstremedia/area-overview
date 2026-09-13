import { describe, expect, it } from 'vitest';
import { formatAge, isStale } from './staleness.js';

describe('isStale', () => {
    it('is not stale within three poll intervals', () => {
        const now = new Date('2026-01-01T12:00:00Z');
        const fetchedAt = new Date('2026-01-01T11:59:00Z'); // 60s ago
        expect(isStale({ fetchedAt, intervalMs: 30_000 }, now)).toBe(false); // 60s < 90s (3x30s)
    });

    it('is stale once older than three poll intervals', () => {
        const now = new Date('2026-01-01T12:00:00Z');
        const fetchedAt = new Date('2026-01-01T11:58:29Z'); // 91s ago
        expect(isStale({ fetchedAt, intervalMs: 30_000 }, now)).toBe(true); // 91s > 90s
    });

    it('is exactly at the boundary (not stale at precisely 3x)', () => {
        const now = new Date('2026-01-01T12:00:00Z');
        const fetchedAt = new Date('2026-01-01T11:58:30Z'); // exactly 90s ago
        expect(isStale({ fetchedAt, intervalMs: 30_000 }, now)).toBe(false);
    });
});

describe('formatAge', () => {
    it('formats a sub-minute age as seconds only', () => {
        const now = new Date('2026-01-01T12:00:20Z');
        const fetchedAt = new Date('2026-01-01T12:00:00Z');
        expect(formatAge(fetchedAt, now)).toBe('20 s');
    });

    it('formats a multi-minute age as minutes and seconds', () => {
        const now = new Date('2026-01-01T12:04:20Z');
        const fetchedAt = new Date('2026-01-01T12:00:00Z');
        expect(formatAge(fetchedAt, now)).toBe('4 min 20 s');
    });

    it('drops the seconds once the age passes an hour', () => {
        const now = new Date('2026-01-01T14:14:07Z');
        const fetchedAt = new Date('2026-01-01T12:00:00Z');
        expect(formatAge(fetchedAt, now)).toBe('2 t 14 min');
    });

    it('formats exactly one hour as the hour alone, with no zero minutes', () => {
        const now = new Date('2026-01-01T13:00:00Z');
        const fetchedAt = new Date('2026-01-01T12:00:00Z');
        expect(formatAge(fetchedAt, now)).toBe('1 t');
    });

    it('formats exactly one day as a single day, with no zero hours', () => {
        const now = new Date('2026-01-02T12:00:00Z');
        const fetchedAt = new Date('2026-01-01T12:00:00Z');
        expect(formatAge(fetchedAt, now)).toBe('1 døgn');
    });

    it('drops the minutes once the age passes a day', () => {
        const now = new Date('2026-01-04T10:31:40Z');
        const fetchedAt = new Date('2026-01-01T12:00:00Z');
        expect(formatAge(fetchedAt, now)).toBe('2 døgn 22 t');
    });

    // The bug this rollup exists for: a Vegvesen ferry-timetable notice
    // untouched for ~3.9 days, which used to render as "5 598 min 47 s".
    it('formats a multi-day age without any minutes at all', () => {
        const fetchedAt = new Date('2026-01-01T12:00:00Z');
        const now = new Date(fetchedAt.getTime() + (5_598 * 60 + 47) * 1000); // the exact age from the bug report
        const age = formatAge(fetchedAt, now);
        expect(age).toBe('3 døgn 21 t');
        expect(age).not.toContain('min');
    });
});
