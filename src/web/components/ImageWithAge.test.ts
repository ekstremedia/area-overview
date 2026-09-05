import { describe, expect, it } from 'vitest';
import { formatImageAge, imageWithAge } from './ImageWithAge.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

describe('imageWithAge', () => {
    it('renders a lazy-loaded image with an aspect ratio reserved and no cache-buster appended to the given URL', () => {
        const now = new Date('2026-09-05T12:02:00Z');
        const el = imageWithAge({
            src: 'https://example.test/current.jpg?v=1725530400',
            alt: 'Sigerfjord',
            updatedAt: new Date('2026-09-05T12:00:00Z'),
            staleAfterMs: ONE_HOUR_MS,
            now,
        });

        const img = el.querySelector<HTMLImageElement>('img');
        expect(img).not.toBeNull();
        expect(img?.loading).toBe('lazy');
        expect(img?.src).toBe('https://example.test/current.jpg?v=1725530400'); // verbatim -- no `Date.now()`/second `?v=` appended
        expect(el.style.aspectRatio).toBe('16 / 9');
    });

    it('shows a "no image" state instead of a broken <img> when src is null', () => {
        const el = imageWithAge({ src: null, alt: 'Spjutvika', updatedAt: null, staleAfterMs: ONE_HOUR_MS });

        expect(el.querySelector('img')).toBeNull();
        expect(el.querySelector('.image-with-age-no-image')).not.toBeNull();
    });

    it('badges a fresh image cyan and an image older than the threshold yellow', () => {
        const now = new Date('2026-09-05T12:10:00Z');

        const fresh = imageWithAge({
            src: 'https://example.test/a.jpg',
            alt: 'a',
            updatedAt: new Date('2026-09-05T12:08:00Z'), // 2 min old
            staleAfterMs: ONE_HOUR_MS,
            now,
        });
        const freshBadge = fresh.querySelector('.image-with-age-badge');
        expect(freshBadge?.classList.contains('image-with-age-badge--fresh')).toBe(true);
        expect(freshBadge?.textContent).toBe('2 min');

        const stale = imageWithAge({
            src: 'https://example.test/b.jpg',
            alt: 'b',
            updatedAt: new Date('2026-09-04T10:00:00Z'), // well over an hour old
            staleAfterMs: ONE_HOUR_MS,
            now,
        });
        const staleBadge = stale.querySelector('.image-with-age-badge');
        expect(staleBadge?.classList.contains('image-with-age-badge--stale')).toBe(true);
    });

    it('renders no age badge at all when updatedAt is unknown', () => {
        const el = imageWithAge({ src: 'https://example.test/a.jpg', alt: 'a', updatedAt: null, staleAfterMs: ONE_HOUR_MS });
        expect(el.querySelector('.image-with-age-badge')).toBeNull();
    });
});

describe('formatImageAge', () => {
    it('escalates from minutes to hours to days as the age grows', () => {
        expect(formatImageAge(2 * 60_000)).toBe('2 min');
        expect(formatImageAge(5 * 3_600_000)).toBe('5 t');
        expect(formatImageAge(19 * 86_400_000)).toBe('19 døgn');
    });
});
