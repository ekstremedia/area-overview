/**
 * Proves `MapPage.ts`'s dynamic `Promise.all([import('leaflet'), ...])`
 * failing doesn't become an unhandled promise rejection with a silently
 * blank route -- it must render a `t()`-driven "map unavailable" message
 * with a reload affordance instead. `leaflet` itself is mocked to throw on
 * import (a real possibility on a kiosk over unreliable Wi-Fi, or a
 * corrupted CDN/cache chunk); every other module `MapPage.ts` statically
 * imports (device-settings, night-schedule, markers, ...) loads for real,
 * same as it would in the real failure this test models -- only the
 * dynamic Leaflet import itself is broken.
 *
 * The `isInsideLeafletPopup` describe block below is unrelated to that
 * failure scenario -- it covers the tap-empty-map point forecast's guard
 * against a click leaking in from inside an already-open popup (see that
 * function's doc comment in `MapPage.ts`). It's a plain unit test of the
 * exported pure function rather than a simulated DOM click sequence: a
 * real pointer/mouse sequence landing on popup content is what reproduced
 * the leak against the live site, but a *bare* synthetic `.click()` (the
 * only kind happy-dom's event dispatch can drive convincingly) does not --
 * Leaflet's own `disableClickPropagation` shield still stops that one, so
 * a DOM-level regression test here would pass whether or not the fix
 * exists, and wouldn't actually be exercising anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('leaflet', () => {
    throw new Error('leaflet chunk failed to load');
});
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const { render, isInsideLeafletPopup } = await import('./MapPage.js');

describe('MapPage / dynamic Leaflet import failure', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders a map-unavailable message with a reload control instead of leaving the route silently blank', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const container = document.createElement('div');

        const dispose = render(container);

        await vi.waitFor(() => {
            expect(container.querySelector('.map-unavailable')).not.toBeNull();
        });

        const reloadButton = container.querySelector('.map-unavailable button');
        expect(reloadButton).not.toBeNull();
        expect(console.error).toHaveBeenCalled();

        dispose();
    });

    it('does not render the fallback if the page is disposed before the failed import settles', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const container = document.createElement('div');

        const dispose = render(container);
        dispose(); // navigate away immediately, before the rejected import is even observed

        // Give the microtask queue a turn so the rejection (and its catch
        // handler) has a chance to run.
        await Promise.resolve();
        await Promise.resolve();

        expect(container.querySelector('.map-unavailable')).toBeNull();
    });
});

describe('isInsideLeafletPopup', () => {
    it('returns false for a plain map click target (not inside any popup)', () => {
        const mapPane = document.createElement('div');
        mapPane.className = 'leaflet-map-pane';
        document.body.append(mapPane);

        expect(isInsideLeafletPopup(mapPane)).toBe(false);

        mapPane.remove();
    });

    it('returns true for a click landing directly on the popup root', () => {
        const popup = document.createElement('div');
        popup.className = 'leaflet-popup';
        document.body.append(popup);

        expect(isInsideLeafletPopup(popup)).toBe(true);

        popup.remove();
    });

    it('returns true for a click on a cluster-list row nested inside an open popup -- the exact leak reported live: clicking a row closed the popup and moved the point-forecast panel instead of showing that ship/aircraft', () => {
        const popup = document.createElement('div');
        popup.className = 'leaflet-popup';
        const wrapper = document.createElement('div');
        wrapper.className = 'leaflet-popup-content-wrapper';
        const content = document.createElement('div');
        content.className = 'leaflet-popup-content';
        const row = document.createElement('button');
        row.className = 'ship-cluster-popup-row';
        const rowLabel = document.createElement('span');
        rowLabel.className = 'ship-cluster-popup-row-name';
        row.append(rowLabel);
        content.append(row);
        wrapper.append(content);
        popup.append(wrapper);
        document.body.append(popup);

        // A real click can land on a descendant several levels deep (e.g. the
        // row's own name span), not just the row element itself.
        expect(isInsideLeafletPopup(rowLabel)).toBe(true);
        expect(isInsideLeafletPopup(row)).toBe(true);

        popup.remove();
    });

    it('returns false for null (no originalEvent.target, or a non-Element EventTarget)', () => {
        expect(isInsideLeafletPopup(null)).toBe(false);
    });
});
