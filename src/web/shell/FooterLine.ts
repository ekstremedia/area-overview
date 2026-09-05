/**
 * The footer line: attribution (left) and "Updated ... ago" (right) --
 * both page-supplied via `page-status.ts`, so this component stays a
 * dumb reader. While the night schedule is active, both are replaced by
 * a single note (artboard 09: "Nattplan aktiv 23:00-06:00 · ett trykk
 * løfter sløret i 30 s"), matching the design's night-mode artboard,
 * which shows nothing else in the footer position.
 */
import { formatRelative, t } from '../i18n/index.js';
import { effect, signal } from '../core/signal.js';
import { nightSchedule } from './night-schedule.js';
import { pageAttribution, pageFreshness } from './page-status.js';

/** Mirrors `Masthead.ts`'s own clock tick cadence -- see that file's `CLOCK_TICK_MS`. */
const RELATIVE_TIME_TICK_MS = 60_000;

export function mountFooterLine(container: HTMLElement): () => void {
    container.className = 'footer-line chrome';

    const attribution = document.createElement('span');
    attribution.className = 'footer-attribution';

    const updated = document.createElement('span');
    updated.className = 'footer-updated';

    const nightNote = document.createElement('span');
    nightNote.className = 'footer-night-note';

    container.append(attribution, updated, nightNote);

    const disposers: (() => void)[] = [];

    disposers.push(
        effect(() => {
            const custom = pageAttribution.get();
            attribution.textContent = custom ?? t('footer.attributionPlaceholder');
        }),
    );

    // `formatRelative`'s output must re-evaluate on a timer, not only when
    // `pageFreshness`/the language changes -- otherwise "Updated X ago" can
    // freeze at a stale value for far longer than it claims on a long-lived
    // kiosk session. Mirrors `Masthead.ts`'s identical `tick` pattern.
    const tick = signal(Date.now());
    const tickTimer = setInterval(() => {
        tick.set(Date.now());
    }, RELATIVE_TIME_TICK_MS);
    disposers.push(() => {
        clearInterval(tickTimer);
    });

    disposers.push(
        effect(() => {
            tick.get(); // re-evaluate the relative-time string on the same cadence as the tick, not just when pageFreshness changes
            const freshness = pageFreshness.get();
            updated.textContent = freshness ? t('footer.updated', { relative: formatRelative(freshness.fetchedAt) }) : '';
        }),
    );

    disposers.push(
        effect(() => {
            const night = nightSchedule.get();
            if (night.active) {
                nightNote.textContent = t('footer.nightScheduleActive', { from: night.from, to: night.to });
            }
            nightNote.style.display = night.active ? '' : 'none';
            attribution.style.display = night.active ? 'none' : '';
            updated.style.display = night.active ? 'none' : '';
        }),
    );

    return function dispose(): void {
        for (const disposeOne of disposers) disposeOne();
        container.innerHTML = '';
    };
}
