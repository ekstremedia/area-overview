/**
 * `mountShipsLayer`'s reactive mount/unmount and disposal, using a fake
 * `L`/`Leaflet.Map` (same convention as `homeView.test.ts`'s `fakeMap`)
 * so this exercises real reactivity/polling without a real Leaflet
 * canvas -- the canvas rendering itself is exercised structurally by
 * `canvasGlyphLayer.ts`'s use of `glyphs.ts`, already unit-tested in
 * `glyphs.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({ ships: { enabled: false, pollSeconds: 10, maxAgeMinutes: 30 } }));
vi.mock('../../settings-resource.js', () => ({ settings: mockSettings }));

const { mountShipsLayer } = await import('./ships.js');

function fakePolygon() {
    const polygon = {
        addTo: () => polygon,
        setLatLngs: () => polygon,
        setStyle: () => polygon,
        bindPopup: () => polygon,
        isPopupOpen: () => false,
        setPopupContent: () => polygon,
    };
    return polygon;
}

function fakeLayerGroup() {
    const group = {
        addTo: () => group,
        addLayer: () => group,
        removeLayer: () => group,
    };
    return group;
}

function fakeLeaflet(): typeof Leaflet {
    return {
        canvas: () => ({}),
        layerGroup: fakeLayerGroup,
        polygon: fakePolygon,
        latLng: (lat: number, lng: number) => ({ lat, lng }),
        point: (x: number, y: number) => ({ x, y }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as typeof Leaflet;
}

function fakeMap(): { map: Leaflet.Map; onCalls: string[]; offCalls: string[] } {
    const onCalls: string[] = [];
    const offCalls: string[] = [];
    const map = {
        getZoom: () => 10,
        project: () => ({ x: 0, y: 0 }),
        unproject: () => ({ lat: 0, lng: 0 }),
        on: (event: string) => {
            onCalls.push(event);
        },
        off: (event: string) => {
            offCalls.push(event);
        },
        removeLayer: () => undefined,
        getBounds: () => ({ getWest: () => 14.0, getSouth: () => 68.0, getEast: () => 16.0, getNorth: () => 69.0 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Leaflet.Map;
    return { map, onCalls, offCalls };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('mountShipsLayer', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ ships: { enabled: false, pollSeconds: 10, maxAgeMinutes: 30 } }));
    });

    it('does not poll while settings.ships.enabled is false', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ configured: false }));
        vi.stubGlobal('fetch', fetchMock);
        const { map } = fakeMap();

        const dispose = mountShipsLayer(fakeLeaflet(), map, { reportCount: vi.fn(), reportAttribution: vi.fn() });

        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetchMock).not.toHaveBeenCalled();

        dispose();
    });

    it('starts polling the moment settings.ships.enabled flips true, and stops the moment it flips back to false', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ configured: false }));
        vi.stubGlobal('fetch', fetchMock);
        const { map } = fakeMap();
        const reportCount = vi.fn();
        const reportAttribution = vi.fn();

        const dispose = mountShipsLayer(fakeLeaflet(), map, { reportCount, reportAttribution });
        expect(fetchMock).not.toHaveBeenCalled();

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        await vi.advanceTimersByTimeAsync(0); // resource() fetches immediately on mount

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toBe('/api/ships?bbox=14,68,16,69');

        await vi.advanceTimersByTimeAsync(10_000); // one poll interval
        expect(fetchMock).toHaveBeenCalledTimes(2);

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: false, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const callsAtDisable = fetchMock.mock.calls.length;

        await vi.advanceTimersByTimeAsync(30_000); // several more would-be intervals
        expect(fetchMock).toHaveBeenCalledTimes(callsAtDisable); // no further polls once disabled

        dispose();
    });

    it('reports zero count and clears attribution on dispose, with no leaked map listeners', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ configured: false })));
        const { map, onCalls, offCalls } = fakeMap();
        const reportCount = vi.fn();
        const reportAttribution = vi.fn();

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet(), map, { reportCount, reportAttribution });
        await vi.advanceTimersByTimeAsync(0);

        dispose();

        expect(reportCount).toHaveBeenLastCalledWith(0);
        expect(reportAttribution).toHaveBeenLastCalledWith(undefined);
        // Every `map.on(...)` registered by the canvas glyph layer (e.g. 'zoomend') is matched by a `map.off(...)` on dispose.
        expect(offCalls.sort()).toEqual(onCalls.sort());
    });
});
