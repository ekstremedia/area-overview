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
});
