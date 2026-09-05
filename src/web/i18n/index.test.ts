import { describe, expect, it, vi } from 'vitest';
import { effect, signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

// `settings-resource.js` is mocked so the test controls `language`
// directly (no real fetch, no waiting on `resource()`'s polling), and so
// `currentLanguage`/`locale` in `index.ts` -- which import `settings`
// from that module -- observe the change reactively, same as they would
// against the real resource.
const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { currentLanguage, formatNumber, formatRelative, formatTime, locale, t } = await import('./index.js');

function setLanguage(language: 'nb' | 'en'): void {
    mockSettings.set({ ...mockSettings.get(), language });
}

describe('t', () => {
    it('renders a key with no placeholders', () => {
        setLanguage('nb');
        expect(t('nav.map')).toBe('Kart');
        setLanguage('en');
        expect(t('nav.map')).toBe('Map');
    });

    it('interpolates a single {param}', () => {
        setLanguage('nb');
        expect(t('masthead.stale', { duration: '4 min 20 s' })).toBe('Gamle data · 4 min 20 s');
    });

    it('interpolates multiple params', () => {
        setLanguage('en');
        expect(t('footer.nightScheduleActive', { from: '23:00', to: '06:00' })).toBe(
            'Night schedule active 23:00–06:00 · one tap lifts the veil for 30 s',
        );
    });

    it('accepts a numeric param value', () => {
        setLanguage('nb');
        expect(t('masthead.layerCounts', { ships: 14, aircraft: 3 })).toBe('14 skip · 3 fly');
    });
});

describe('currentLanguage / locale', () => {
    it('reflects settings.language reactively', () => {
        setLanguage('nb');
        expect(currentLanguage.get()).toBe('nb');
        expect(locale.get()).toBe('nb-NO');

        setLanguage('en');
        expect(currentLanguage.get()).toBe('en');
        expect(locale.get()).toBe('en-GB');
    });

    it('re-runs an effect reading t() when the language changes, with no other trigger', () => {
        setLanguage('nb');
        const seen: string[] = [];
        const dispose = effect(() => {
            seen.push(t('nav.weather'));
        });
        expect(seen).toEqual(['Vær']);

        setLanguage('en');
        expect(seen).toEqual(['Vær', 'Weather']);

        dispose();
    });
});

describe('formatTime', () => {
    it('formats a 24-hour HH:MM', () => {
        setLanguage('nb');
        const date = new Date('2026-01-01T12:42:00');
        expect(formatTime(date)).toMatch(/12:42/);
    });
});

describe('formatNumber', () => {
    it('formats a plain number using the current locale', () => {
        setLanguage('nb');
        expect(formatNumber(7.4)).toBe('7,4');
        setLanguage('en');
        expect(formatNumber(7.4)).toBe('7.4');
    });

    it('appends a unit when given one', () => {
        setLanguage('nb');
        expect(formatNumber(6.2, 'm/s')).toBe('6,2 m/s');
    });
});

describe('formatRelative', () => {
    it('formats a past date in seconds', () => {
        setLanguage('en');
        const now = new Date('2026-01-01T12:00:20Z');
        const date = new Date('2026-01-01T12:00:00Z');
        expect(formatRelative(date, now)).toMatch(/20 seconds ago/);
    });

    it('picks minutes once the age crosses a minute', () => {
        setLanguage('en');
        const now = new Date('2026-01-01T12:04:00Z');
        const date = new Date('2026-01-01T12:00:00Z');
        expect(formatRelative(date, now)).toMatch(/4 minutes ago/);
    });
});
