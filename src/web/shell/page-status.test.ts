/**
 * `claimPageStatus`'s one job: surviving the window where two pages are
 * mounted at once.
 *
 * The shell slides between pages (`AppShell.ts`), which means the
 * incoming page renders -- and publishes its own attribution and
 * freshness -- while the outgoing page is still on screen, and the
 * outgoing page is disposed only when the slide ends. A page that
 * cleared the shared slots unconditionally on dispose therefore wiped its
 * successor's: the footer's attribution line went blank at the end of
 * every transition, and the page above it visibly grew into the gap.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { claimPageStatus, pageAttribution, pageFreshness } from './page-status.js';

beforeEach(() => {
    pageAttribution.set(null);
    pageFreshness.set(null);
});

describe('claimPageStatus', () => {
    it('clears the slots when the page that still owns them is disposed', () => {
        const release = claimPageStatus();
        pageAttribution.set('Data: Kystverket / BarentsWatch');
        pageFreshness.set({ fetchedAt: new Date('2026-09-08T12:00:00Z'), intervalMs: 30_000 });

        release();

        expect(pageAttribution.get()).toBeNull();
        expect(pageFreshness.get()).toBeNull();
    });

    it('leaves the incoming line alone when the outgoing page is disposed after it', () => {
        // Exactly the order a slide produces: outgoing claims, incoming
        // claims and publishes, outgoing is disposed last.
        const releaseOutgoing = claimPageStatus();
        pageAttribution.set('Data: adsb.fi');

        const releaseIncoming = claimPageStatus();
        pageAttribution.set('MET.no / Yr');

        releaseOutgoing();

        expect(pageAttribution.get()).toBe('MET.no / Yr');

        releaseIncoming();
        expect(pageAttribution.get()).toBeNull();
    });

    it('is inert when released twice, so a double dispose cannot blank a later page', () => {
        const release = claimPageStatus();
        release();

        claimPageStatus();
        pageAttribution.set('Kartverket');
        release();

        expect(pageAttribution.get()).toBe('Kartverket');
    });
});
