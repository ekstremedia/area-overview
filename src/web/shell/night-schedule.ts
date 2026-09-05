/**
 * The reactive evaluation of `settings.night` against the device's wall
 * clock. Shared between `DisplayOverlay.ts` (which reacts to it to draw
 * the dim/off/dark veil) and `FooterLine.ts` (which shows a note while
 * the schedule is active) so the two never disagree about what "active"
 * means.
 *
 * Re-evaluated once a minute (`setInterval`, 60_000ms) plus once
 * immediately -- per the phase spec, a live per-second check buys
 * nothing here.
 */
import { computed, signal, type ReadonlySignal } from '../core/signal.js';
import { settings } from '../settings-resource.js';
import type { Settings } from '../../shared/schemas/settings.js';

export interface NightScheduleState {
    active: boolean;
    mode: Settings['night']['mode'];
    from: string;
    to: string;
}

function toMinutesSinceMidnight(hhmm: string): number {
    const [hoursPart, minutesPart] = hhmm.split(':');
    const hours = Number(hoursPart);
    const minutes = Number(minutesPart);
    return (Number.isNaN(hours) ? 0 : hours) * 60 + (Number.isNaN(minutes) ? 0 : minutes);
}

/**
 * Whether `now`'s wall-clock time falls in `[from, to)`. `from` may be
 * later than `to` in clock terms, meaning the window wraps past midnight
 * (e.g. `from: '23:00', to: '06:00'` is active from 11pm through 6am).
 * `from === to` is treated as "never active" (a zero-length window),
 * rather than "always active" (a full-day window) -- the schedule form
 * has no separate way to express "always on", so an operator who sets
 * matching times almost certainly means "off", not "always dim".
 */
export function isWithinNightWindow(from: string, to: string, now: Date): boolean {
    const fromMinutes = toMinutesSinceMidnight(from);
    const toMinutes = toMinutesSinceMidnight(to);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    if (fromMinutes === toMinutes) return false;
    if (fromMinutes < toMinutes) {
        return nowMinutes >= fromMinutes && nowMinutes < toMinutes;
    }
    return nowMinutes >= fromMinutes || nowMinutes < toMinutes;
}

const tick = signal(Date.now());
setInterval(() => {
    tick.set(Date.now());
}, 60_000);

export const nightSchedule: ReadonlySignal<NightScheduleState> = computed(() => {
    const night = settings.get().night;
    const now = new Date(tick.get());
    return {
        active: night.enabled && isWithinNightWindow(night.from, night.to, now),
        mode: night.mode,
        from: night.from,
        to: night.to,
    };
});
