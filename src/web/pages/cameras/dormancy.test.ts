/**
 * Dormancy: Terje's own cameras are hidden, and *only* hidden.
 *
 * Two halves, and both matter. The map draws no camera pin and the
 * cameras page has left the navigation and the slideshow -- but
 * `#/cameras/<id>` still resolves to the viewer, because a kiosk
 * bookmark (or a link somebody saved) must not land on a silent fallback
 * to the map. `CameraViewerPage.ts` and `ImageWithAge.ts` are untouched
 * on disk and keep their own tests.
 *
 * The flag itself is asserted `true` here deliberately: this file
 * describes the *dormant* state, so flipping `CAMERAS_DORMANT` back is
 * meant to fail here first and loudly, rather than leaving a suite that
 * silently describes a state the app is no longer in.
 */
import { describe, expect, it } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema } from '../../../shared/schemas/settings.js';
import { nextCycleRoute } from '../../shell/autoCycle.js';
import { parseHash } from '../../core/router.js';
import { NAV_PAGES, pageForRoute } from '../registry.js';
import { createCameraMarkerLayer } from '../map/markers.js';
import { CAMERAS_DORMANT } from './dormancy.js';

describe('CAMERAS_DORMANT', () => {
    it('is on -- the flag this whole file describes', () => {
        expect(CAMERAS_DORMANT).toBe(true);
    });
});

describe('the cameras page while dormant', () => {
    it('has no tab in the masthead', () => {
        expect(NAV_PAGES.map((page) => page.name)).toEqual(['map', 'weather', 'aurora', 'tide']);
    });

    it('still resolves #/cameras/<id> to the camera viewer, so an old bookmark is not a dead link', () => {
        const route = parseHash('#/cameras/sigerfjordveien_01');

        expect(route).toEqual({ name: 'cameras', cameraId: 'sigerfjordveien_01' });
        // A registered route, not the map fallback -- `pageForRoute`
        // throws if nothing is registered for the name.
        expect(pageForRoute(route).navKey).toBe('nav.cameras');
    });

    it('is skipped by the kiosk slideshow even on a display whose settings still enable it', () => {
        // Exactly the shape of an existing `data/settings.json` on the
        // NUC: `'cameras'` is still a legal, still-parsing page id.
        const settings = SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] } });
        const withCameras = { ...settings, enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] as const };

        expect(nextCycleRoute('tide', { ...settings, enabledPages: [...withCameras.enabledPages] })).toBe('map');
    });
});

describe('createCameraMarkerLayer while dormant', () => {
    it('mounts no camera marker at all, while still adding and removing its (empty) layer group', async () => {
        const markers: unknown[] = [];
        const group = { addTo: () => group, addLayer: () => group, removeLayer: () => group };
        const removed: unknown[] = [];
        const L = {
            layerGroup: () => group,
            divIcon: (options: unknown) => options,
            marker: (...args: unknown[]) => {
                markers.push(args);
                return { addTo: () => undefined, bindPopup: () => undefined };
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any as typeof Leaflet;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const map = { removeLayer: (layer: unknown) => removed.push(layer) } as any as Leaflet.Map;

        const layer = createCameraMarkerLayer(L, map, () => document.createElement('div'));
        // Synchronously empty, and it stays that way: the `effect()`
        // subscription is skipped outright, so no `requestAnimationFrame`
        // flush is ever scheduled to arrive later with markers in it.
        expect(markers).toEqual([]);
        await new Promise((resolve) => {
            requestAnimationFrame(() => {
                resolve(undefined);
            });
        });
        expect(markers).toEqual([]);

        layer.dispose();
        expect(removed).toEqual([group]);
    });
});
