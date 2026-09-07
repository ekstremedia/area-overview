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

 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('leaflet', () => {
    throw new Error('leaflet chunk failed to load');
});
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const { render } = await import('./MapPage.js');

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
