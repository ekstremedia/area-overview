/**
 * The staleness *mechanism*: given when a page's data was last fetched
 * and how often it's supposed to refresh, is it old enough to warn
 * about? Pure functions only -- see `page-status.ts` for the shared
 * signals a page publishes its freshness/attribution/layer-counts
 * through.
 */
import { formatNumber, t } from '../i18n/index.js';

export interface Freshness {
    fetchedAt: Date;
    /** The page's own poll interval, in milliseconds. */
    intervalMs: number;
}

/** Stale once the data is older than three full poll intervals. */
export function isStale(freshness: Freshness, now: Date = new Date()): boolean {
    return now.getTime() - freshness.fetchedAt.getTime() > freshness.intervalMs * 3;
}

/**
 * "20 s" / "4 min 20 s" / "2 t 14 min" / "3 døgn 21 t" -- a compact age,
 * for the stale banner and for map popups' "Oppdatert ..." line. Numerals
 * go through `formatNumber`, units through `t()`.
 *
 * Two units at most, and each step up drops the finest one: past an hour
 * the seconds are noise, past a day the minutes are. The masthead's own
 * data is seconds or minutes old, but a map popup's `updatedAt` belongs to
 * the *source* -- a Vegvesen ferry-timetable notice can sit untouched for
 * days, and rendering that as "5 598 min 47 s" reads as a bug in the app
 * rather than a fact about the notice.
 *
 * A zero remainder is omitted in the hour and day tiers ("1 t", not
 * "1 t 0 min"), which is the shortest thing that is still true -- on a
 * wall display read from across the room, every token has to earn its
 * place. Below an hour the exact old rendering is kept, zero seconds and
 * all, because the stale banner ticking down second by second is the whole
 * point of that tier.
 */
export function formatAge(fetchedAt: Date, now: Date = new Date()): string {
    const totalSeconds = Math.max(0, Math.floor((now.getTime() - fetchedAt.getTime()) / 1000));
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const totalDays = Math.floor(totalHours / 24);

    if (totalDays > 0) {
        const daysUnit = totalDays === 1 ? t('unit.day') : t('unit.days');
        const hours = totalHours % 24;
        const daysPart = `${formatNumber(totalDays)} ${daysUnit}`;
        if (hours === 0) return daysPart;
        return `${daysPart} ${formatNumber(hours)} ${t('unit.hours')}`;
    }

    if (totalHours > 0) {
        const minutes = totalMinutes % 60;
        const hoursPart = `${formatNumber(totalHours)} ${t('unit.hours')}`;
        if (minutes === 0) return hoursPart;
        return `${hoursPart} ${formatNumber(minutes)} ${t('unit.minutes')}`;
    }

    const seconds = totalSeconds % 60;
    const secondsPart = `${formatNumber(seconds)} ${t('unit.seconds')}`;
    if (totalMinutes === 0) return secondsPart;
    return `${formatNumber(totalMinutes)} ${t('unit.minutes')} ${secondsPart}`;
}
