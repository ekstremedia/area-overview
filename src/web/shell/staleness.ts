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

/** "4 min 20 s" -- a compact age, for the stale banner. Numerals go through `formatNumber`, units through `t()`. */
export function formatAge(fetchedAt: Date, now: Date = new Date()): string {
    const totalSeconds = Math.max(0, Math.floor((now.getTime() - fetchedAt.getTime()) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const secondsPart = `${formatNumber(seconds)} ${t('unit.seconds')}`;
    if (minutes === 0) return secondsPart;
    return `${formatNumber(minutes)} ${t('unit.minutes')} ${secondsPart}`;
}
