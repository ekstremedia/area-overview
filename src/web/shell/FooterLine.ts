/**
 * The footer line: the data credits for whatever the current page is
 * showing, page-supplied via `page-status.ts` so this component stays a
 * dumb reader. While the night schedule is active it is replaced by a
 * single note (artboard 09: "Nattplan aktiv 23:00-06:00 · ett trykk
 * løfter sløret i 30 s"), matching the design's night-mode artboard.
 *
 * The 2026-09-07 design removes the footer entirely. It survives in this
 * reduced form because several of the upstreams require visible credit as
 * a licence condition -- OpenStreetMap and adsb.lol are ODbL, Kartverket
 * is NLOD, MET.no and CARTO ask for it in their terms -- and this app is
 * served publicly. What did go is everything that was *not* required:
 * the "Oppdatert ... siden" relative time (the masthead's stale banner
 * already covers the case that matters, and the camera viewer keeps its
 * own), the "Kilde kommer" placeholder, and the credits for sources Terje
 * owns himself (his Netatmo, his own camera images) -- nobody needs
 * crediting for their own data.
 */
import { t } from '../i18n/index.js';
import { effect } from '../core/signal.js';
import { nightSchedule } from './night-schedule.js';
import { pageAttribution } from './page-status.js';

export function mountFooterLine(container: HTMLElement): () => void {
    container.className = 'footer-line chrome';

    const attribution = document.createElement('span');
    attribution.className = 'footer-attribution';

    const nightNote = document.createElement('span');
    nightNote.className = 'footer-night-note';

    container.append(attribution, nightNote);

    const disposers: (() => void)[] = [];

    disposers.push(
        effect(() => {
            // No placeholder: a page with nothing to credit shows an empty
            // footer rather than "Kilde kommer".
            attribution.textContent = pageAttribution.get() ?? '';
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
        }),
    );

    return function dispose(): void {
        for (const disposeOne of disposers) disposeOne();
        container.innerHTML = '';
    };
}
