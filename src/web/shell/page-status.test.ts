/**
 * `claimPageStatus`'s one job: surviving the window where two pages are
 * mounted at once.
 *
 * The shell slides between pages (`AppShell.ts`), which means the
 * incoming page renders -- and publishes its own attribution, freshness
 * and counts -- while the outgoing page is still on screen and still
 * polling, and the outgoing page is disposed only when the slide ends.
 * Both bugs below were seen on the live kiosk: a footer credit line that
 * went blank the instant a transition finished (and a page that grew a
 * line taller as it did), and the map's "22 skip" still sitting in the
 * masthead on the cameras page.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { claimPageStatus, liveLayerCounts, pageAttribution, pageFreshness } from './page-status.js';

beforeEach(() => {
    pageAttribution.set(null);
    pageFreshness.set(null);
    liveLayerCounts.set(null);
});

describe('claimPageStatus', () => {
    it('clears the slots when the page that still owns them is disposed', () => {
        const status = claimPageStatus();
        status.attribution('Data: Kystverket / BarentsWatch');
        status.freshness({ fetchedAt: new Date('2026-09-08T12:00:00Z'), intervalMs: 30_000 });

        status.release();

        expect(pageAttribution.get()).toBeNull();
        expect(pageFreshness.get()).toBeNull();
    });

    it('leaves the incoming line alone when the outgoing page is disposed after it', () => {
        // Exactly the order a slide produces: outgoing claims, incoming
        // claims and publishes, outgoing is disposed last.
        const outgoing = claimPageStatus();
        outgoing.attribution('Data: adsb.fi');

        const incoming = claimPageStatus();
        incoming.attribution('MET.no / Yr');

        outgoing.release();

        expect(pageAttribution.get()).toBe('MET.no / Yr');

        incoming.release();
        expect(pageAttribution.get()).toBeNull();
    });

    it('clears a slot the incoming page never wrote to', () => {
        // The cameras page publishes no attribution at all. Arriving from
        // the aurora page, it must show an empty footer rather than
        // inherit "Data provided by NOAA ..." -- so "a newer page exists"
        // cannot be enough on its own to hold a slot.
        const aurora = claimPageStatus();
        aurora.attribution('Data provided by NOAA Space Weather Prediction Center');

        claimPageStatus(); // cameras: claims, publishes nothing
        aurora.release();

        expect(pageAttribution.get()).toBeNull();
    });

    it('holds only the slots the incoming page actually took over', () => {
        const outgoing = claimPageStatus();
        outgoing.attribution('Data: adsb.fi');
        outgoing.freshness({ fetchedAt: new Date('2026-09-08T12:00:00Z'), intervalMs: 30_000 });

        const incoming = claimPageStatus();
        incoming.attribution('MET.no / Yr'); // ... but nothing about freshness yet

        outgoing.release();

        expect(pageAttribution.get()).toBe('MET.no / Yr');
        expect(pageFreshness.get()).toBeNull();
    });

    it('ignores a write from a page that is no longer the live one', () => {
        // The map page keeps polling through the slide. Its counts were
        // still in the masthead on the cameras page afterwards, with no map
        // behind them and nothing left to correct the figure.
        const map = claimPageStatus();
        map.layerCounts({ ships: 22, aircraft: 0, hiddenByAge: 0 });

        claimPageStatus(); // cameras is the live page now
        map.layerCounts({ ships: 23, aircraft: 1, hiddenByAge: 0 }); // a poll that landed mid-slide

        map.release();

        expect(liveLayerCounts.get()).toBeNull();
    });

    it('is inert when released twice, so a double dispose cannot blank a later page', () => {
        const first = claimPageStatus();
        first.release();

        const second = claimPageStatus();
        second.attribution('Kartverket');
        first.release();

        expect(pageAttribution.get()).toBe('Kartverket');
    });
});
