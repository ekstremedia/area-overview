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
const { followTarget, stopFollowing, VESSEL_ZOOM } = await import('./follow.js');
const { autoCycleHeld } = await import('../../shell/autoCycle.js');

function fakePolygon(initial: Record<string, unknown> = {}) {
    const polygon = {
        style: { ...initial },
        tooltip: undefined as HTMLElement | undefined,
        tooltipLatLng: undefined as { lat: number; lng: number } | undefined,
        addTo: () => polygon,
        setLatLngs: () => polygon,
        setStyle: (style: Record<string, unknown>) => {
            polygon.style = { ...polygon.style, ...style };
            return polygon;
        },
        /** Leaflet calls the bound function when a popup opens; keeping it lets a test read the popup this layer would render. */
        popupContent: undefined as (() => HTMLElement) | undefined,
        bindPopup: (content: () => HTMLElement) => {
            polygon.popupContent = content;
            return polygon;
        },
        isPopupOpen: () => false,
        setPopupContent: () => polygon,
        bindTooltip: (content: HTMLElement) => {
            polygon.tooltip = content;
            return polygon;
        },
        // Real Leaflet re-anchors an open tooltip only when told to, so the
        // glyph layer moves it explicitly on every position update; a fake
        // without this would make that call throw.
        getTooltip: () =>
            polygon.tooltip === undefined
                ? undefined
                : {
                      setLatLng: (latLng: { lat: number; lng: number }) => {
                          polygon.tooltipLatLng = latLng;
                      },
                  },
        unbindTooltip: () => {
            polygon.tooltip = undefined;
            return polygon;
        },
        setTooltipContent: (content: HTMLElement) => {
            polygon.tooltip = content;
            return polygon;
        },
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

interface FakeMarker {
    latlng: unknown;
    icon: unknown;
    popupOpen: boolean;
    popupContentFn: (() => HTMLElement) | undefined;
    lastContent: HTMLElement | undefined;
    addTo: () => FakeMarker;
    setLatLng: (latlng: unknown) => FakeMarker;
    setIcon: (icon: unknown) => FakeMarker;
    bindPopup: (content: () => HTMLElement) => FakeMarker;
    isPopupOpen: () => boolean;
    setPopupContent: (content: HTMLElement) => FakeMarker;
    openPopup: () => FakeMarker;
}

function fakeMarker(latlng: unknown, options: { icon?: unknown } = {}): FakeMarker {
    const marker: FakeMarker = {
        latlng,
        icon: options.icon,
        popupOpen: false,
        popupContentFn: undefined,
        lastContent: undefined,
        addTo: () => marker,
        setLatLng: (nextLatLng) => {
            marker.latlng = nextLatLng;
            return marker;
        },
        setIcon: (icon) => {
            marker.icon = icon;
            return marker;
        },
        bindPopup: (content) => {
            marker.popupContentFn = content;
            return marker;
        },
        isPopupOpen: () => marker.popupOpen,
        setPopupContent: (content) => {
            marker.lastContent = content;
            return marker;
        },
        openPopup: () => {
            marker.popupOpen = true;
            marker.lastContent = marker.popupContentFn?.();
            return marker;
        },
    };
    return marker;
}

function fakeLeaflet(createdPolygons: ReturnType<typeof fakePolygon>[] = [], createdMarkers: FakeMarker[] = []): typeof Leaflet {
    return {
        canvas: () => ({}),
        layerGroup: fakeLayerGroup,
        polygon: (_latlngs: unknown, options: Record<string, unknown> = {}) => {
            const polygon = fakePolygon(options);
            createdPolygons.push(polygon);
            return polygon;
        },
        marker: (latlng: unknown, options: { icon?: unknown } = {}) => {
            const marker = fakeMarker(latlng, options);
            createdMarkers.push(marker);
            return marker;
        },
        // The trail layer's own; this file asserts about glyphs and cluster
        // badges, so the segments only need to exist without throwing.
        polyline: () => {
            const line = { addTo: () => line, setLatLngs: () => line, setStyle: () => line };
            return line;
        },
        divIcon: (options: Record<string, unknown>) => ({ __divIcon: true, ...options }),
        latLng: (lat: number, lng: number) => ({ lat, lng }),
        point: (x: number, y: number) => ({ x, y }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as typeof Leaflet;
}

/** A real element, so the follow can attach its gesture listeners, that still reports the laid-out size `mapToBboxQuery` insists on. */
function fakeContainer(): HTMLElement {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 1000 });
    Object.defineProperty(el, 'clientHeight', { value: 600 });
    return el;
}

function fakeMap(): { map: Leaflet.Map; onCalls: string[]; offCalls: string[]; views: { lat: number; lng: number; zoom: number }[] } {
    const onCalls: string[] = [];
    const offCalls: string[] = [];
    const views: { lat: number; lng: number; zoom: number }[] = [];
    const container = fakeContainer();
    const map = {
        getZoom: () => 10,
        // A simple, invertible linear "projection" -- not Web Mercator,
        // but distinct ships get distinct, controllable pixel positions
        // (needed for clustering assertions), and project/unproject
        // round-trip exactly, which is all `cornersToLatLngs`/cluster
        // centroid placement need from a fake.
        project: (latlng: { lat: number; lng: number }) => ({ x: latlng.lng * 1000, y: latlng.lat * 1000 }),
        unproject: (point: { x: number; y: number }) => ({ lat: point.y / 1000, lng: point.x / 1000 }),
        on: (event: string) => {
            onCalls.push(event);
        },
        off: (event: string) => {
            offCalls.push(event);
        },
        removeLayer: () => undefined,
        setView: (latLng: [number, number], zoom: number) => {
            views.push({ lat: latLng[0], lng: latLng[1], zoom });
            return map;
        },
        closePopup: () => map,
        getBounds: () => ({ getWest: () => 14.0, getSouth: () => 68.0, getEast: () => 16.0, getNorth: () => 69.0 }),
        // A laid-out container whose size Leaflet already agrees with --
        // `mapToBboxQuery` skips a viewport it cannot measure, so a fake
        // without a size would make every layer here fetch nothing.
        getContainer: () => container,
        getSize: () => ({ x: 1000, y: 600 }),
        invalidateSize: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Leaflet.Map;
    return { map, onCalls, offCalls, views };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function ship(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        mmsi: '257123456',
        name: 'MS NORDLYS',
        lat: 68.7,
        lng: 15.4,
        speedOverGround: 12.3,
        courseOverGround: 45,
        heading: 47,
        shipType: '60',
        navigationalStatus: 0,
        timestamp: '2026-09-05T12:00:00Z',
        ...overrides,
    };
}

function configuredResponse(ships: Record<string, unknown>[]): { configured: true; ships: Record<string, unknown>[]; fetchedAt: string } {
    return { configured: true, ships, fetchedAt: '2026-09-05T12:00:00Z' };
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

        const dispose = mountShipsLayer(fakeLeaflet(), map, { reportCount: vi.fn(), reportAttribution: vi.fn(), reportItems: vi.fn() });

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

        const dispose = mountShipsLayer(fakeLeaflet(), map, { reportCount, reportAttribution, reportItems: vi.fn() });
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
        const dispose = mountShipsLayer(fakeLeaflet(), map, { reportCount, reportAttribution, reportItems: vi.fn() });
        await vi.advanceTimersByTimeAsync(0);

        dispose();

        expect(reportCount).toHaveBeenLastCalledWith(0, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith(undefined);
        // Every `map.on(...)` registered by the canvas glyph layer (e.g. 'zoomend') is matched by a `map.off(...)` on dispose.
        expect(offCalls.sort()).toEqual(onCalls.sort());
    });
});

describe('mountShipsLayer -- colouring by navigationalStatus', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ ships: { enabled: false, pollSeconds: 10, maxAgeMinutes: 30 } }));
    });

    it('colors a ship with navigationalStatus 0 green, and any other status the default cyan', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const underway = ship({ mmsi: '1', lat: 68.7, lng: 15.4, navigationalStatus: 0 });
        const moored = ship({ mmsi: '2', lat: 60.0, lng: 5.0, navigationalStatus: 5 }); // far away -- must not cluster with the first
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([underway, moored]))));
        const { map } = fakeMap();
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet(createdPolygons), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        // Each ship is a (visible, hitArea) pair, in the order it was added.
        const visiblePolygons = createdPolygons.filter((_, index) => index % 2 === 0);
        expect(visiblePolygons).toHaveLength(2);
        expect(visiblePolygons[0]?.style.color).toBe('#4ade80');
        expect(visiblePolygons[1]?.style.color).toBe('#62c5ee');

        dispose();
    });
});

describe('mountShipsLayer -- name labels', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ ships: { enabled: false, pollSeconds: 10, maxAgeMinutes: 30 } }));
    });

    it('labels an underway ship (navigationalStatus 0) with its name, and gives a non-underway ship no label', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const underway = ship({ mmsi: '1', name: 'MS NORDLYS', lat: 68.7, lng: 15.4, navigationalStatus: 0 });
        const moored = ship({ mmsi: '2', name: 'MS MOORED', lat: 60.0, lng: 5.0, navigationalStatus: 5 }); // far away -- must not cluster with the first
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([underway, moored]))));
        const { map } = fakeMap();
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet(createdPolygons), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        // Each ship is a (visible, hitArea) pair, in the order it was added -- the tooltip lives on the hit area.
        const hitAreas = createdPolygons.filter((_, index) => index % 2 === 1);
        expect(hitAreas).toHaveLength(2);
        expect(hitAreas[0]?.tooltip?.textContent).toBe('MS NORDLYS');
        expect(hitAreas[1]?.tooltip).toBeUndefined();

        dispose();
    });
});

describe('mountShipsLayer -- clustering', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ ships: { enabled: false, pollSeconds: 10, maxAgeMinutes: 30 } }));
    });

    it('a lone ship (no nearby others) renders as an ordinary triangle, with no cluster badge', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([ship()]))));
        const { map } = fakeMap();
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];
        const createdMarkers: FakeMarker[] = [];
        const reportCount = vi.fn();

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet(createdPolygons, createdMarkers), map, {
            reportCount,
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(createdPolygons).toHaveLength(2); // visible + hit area
        expect(createdMarkers).toHaveLength(0); // no cluster badge
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);

        dispose();
    });

    it('renders two close-together ships as a single cluster badge, not two triangles', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        // lng differs by 0.01 -> 10px apart at this fake map's scale, well under the 44px threshold.
        const a = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4 });
        const b = ship({ mmsi: '2', name: 'BRAVO', lat: 68.7, lng: 15.41 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([a, b]))));
        const { map } = fakeMap();
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];
        const createdMarkers: FakeMarker[] = [];
        const reportCount = vi.fn();

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet(createdPolygons, createdMarkers), map, {
            reportCount,
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(createdPolygons).toHaveLength(0); // neither ship rendered as an individual triangle
        expect(createdMarkers).toHaveLength(1); // one badge for both
        const [badge] = createdMarkers;
        const icon = badge?.icon as { html: HTMLElement } | undefined;
        expect(icon?.html.textContent).toBe('2');
        expect(reportCount).toHaveBeenLastCalledWith(2, 0); // total ship count is unaffected by clustering, and nothing is held back by age

        dispose();
    });

    it("colours an underway member's name green in the cluster list popup, and leaves a non-underway member's name uncoloured", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const underway = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4, navigationalStatus: 0 });
        const moored = ship({ mmsi: '2', name: 'BRAVO', lat: 68.7, lng: 15.41, navigationalStatus: 5 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([underway, moored]))));
        const { map } = fakeMap();
        const createdMarkers: FakeMarker[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet([], createdMarkers), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const [badge] = createdMarkers;
        badge?.openPopup();
        const listContent = badge?.lastContent;
        const names = listContent?.querySelectorAll('.ship-cluster-popup-row-name');
        expect(names?.[0]?.textContent).toBe('ALPHA');
        expect(names?.[0]?.classList.contains('ship-cluster-popup-row-name-underway')).toBe(true);
        expect(names?.[1]?.textContent).toBe('BRAVO');
        expect(names?.[1]?.classList.contains('ship-cluster-popup-row-name-underway')).toBe(false);

        dispose();
    });

    it("tapping a cluster badge shows a list, and tapping a row shows that ship's own detail, with a way back", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const a = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4 });
        const b = ship({ mmsi: '2', name: 'BRAVO', lat: 68.7, lng: 15.41 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([a, b]))));
        const { map } = fakeMap();
        const createdMarkers: FakeMarker[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet([], createdMarkers), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const [badge] = createdMarkers;
        badge?.openPopup();
        const listContent = badge?.lastContent;
        expect(listContent?.textContent).toContain('ALPHA');
        expect(listContent?.textContent).toContain('BRAVO');

        const rows = listContent?.querySelectorAll('.ship-cluster-popup-row');
        expect(rows).toHaveLength(2);
        (rows?.[0] as HTMLElement).click();

        const detailContent = badge?.lastContent;
        expect(detailContent?.textContent).toContain('ALPHA');
        expect(detailContent?.textContent).not.toContain('BRAVO');
        const back = detailContent?.querySelector('.ship-cluster-popup-back');
        expect(back).not.toBeNull();

        (back as HTMLElement).click();
        const backToListContent = badge?.lastContent;
        expect(backToListContent?.textContent).toContain('ALPHA');
        expect(backToListContent?.textContent).toContain('BRAVO');

        dispose();
    });

    it('keeps a cluster row tap inside the popup, so the map never closes it under the selection', async () => {
        // Leaflet closes the open popup on the map's own click. The rows sit
        // inside that popup, so a row tap that reached the map container
        // both closed the popup and fired the map click handler -- the ship
        // was selected, but the list vanished and the selection only became
        // visible when the cluster was reopened.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const a = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4 });
        const b = ship({ mmsi: '2', name: 'BRAVO', lat: 68.7, lng: 15.41 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([a, b]))));
        const { map } = fakeMap();
        const createdMarkers: FakeMarker[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet([], createdMarkers), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const [badge] = createdMarkers;
        badge?.openPopup();

        // Stand in for the map container: the popup lives inside it, so a
        // click that bubbles this far is the one that would close the popup.
        const container = document.createElement('div');
        document.body.append(container);
        const reachedMap = vi.fn();
        container.addEventListener('click', reachedMap);

        const listContent = badge?.lastContent;
        if (!listContent) throw new Error('expected the cluster list popup');
        container.append(listContent);

        const row = listContent.querySelector('.ship-cluster-popup-row');
        (row as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(reachedMap).not.toHaveBeenCalled();

        // The selection still happened -- the tap is contained, not swallowed.
        const detailContent = badge.lastContent;
        if (!detailContent) throw new Error('expected the cluster detail popup');
        expect(detailContent.textContent).toContain('ALPHA');
        expect(detailContent.textContent).not.toContain('BRAVO');

        container.append(detailContent);
        const back = detailContent.querySelector('.ship-cluster-popup-back');
        (back as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(reachedMap).not.toHaveBeenCalled();

        container.remove();
        dispose();
    });

    it('gives a cluster badge an underway indicator when at least one member has navigationalStatus 0', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const underway = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4, navigationalStatus: 0 });
        const moored = ship({ mmsi: '2', name: 'BRAVO', lat: 68.7, lng: 15.41, navigationalStatus: 5 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([underway, moored]))));
        const { map } = fakeMap();
        const createdMarkers: FakeMarker[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet([], createdMarkers), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const [badge] = createdMarkers;
        const icon = badge?.icon as { html: HTMLElement } | undefined;
        expect(icon?.html.classList.contains('ship-cluster-badge-count-underway')).toBe(true);

        dispose();
    });

    it('gives a cluster badge no underway indicator when no member has navigationalStatus 0', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const a = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4, navigationalStatus: 5 });
        const b = ship({ mmsi: '2', name: 'BRAVO', lat: 68.7, lng: 15.41, navigationalStatus: 1 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([a, b]))));
        const { map } = fakeMap();
        const createdMarkers: FakeMarker[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet([], createdMarkers), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const [badge] = createdMarkers;
        const icon = badge?.icon as { html: HTMLElement } | undefined;
        expect(icon?.html.classList.contains('ship-cluster-badge-count-underway')).toBe(false);

        dispose();
    });

    it("updates a cluster badge's underway indicator on a later poll once a member's navigationalStatus changes, without membership changing", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const a = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4, navigationalStatus: 5 });
        const b = ship({ mmsi: '2', name: 'BRAVO', lat: 68.7, lng: 15.41, navigationalStatus: 1 });
        const aUnderway = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4, navigationalStatus: 0 });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(configuredResponse([a, b])))
            .mockResolvedValueOnce(jsonResponse(configuredResponse([aUnderway, b]))); // same membership, `a` now underway
        vi.stubGlobal('fetch', fetchMock);
        const { map } = fakeMap();
        const createdMarkers: FakeMarker[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet([], createdMarkers), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(createdMarkers).toHaveLength(1);
        const [badge] = createdMarkers;
        const iconBefore = badge?.icon as { html: HTMLElement } | undefined;
        expect(iconBefore?.html.classList.contains('ship-cluster-badge-count-underway')).toBe(false);

        await vi.advanceTimersByTimeAsync(10_000); // next poll: same two ships, `a` now underway
        expect(createdMarkers).toHaveLength(1); // same badge entry reused (membership/key unchanged)
        const iconAfter = badge?.icon as { html: HTMLElement } | undefined;
        expect(iconAfter?.html.classList.contains('ship-cluster-badge-count-underway')).toBe(true);

        dispose();
    });

    it('closes/replaces a cluster badge (never a stale list) once its membership changes between polls', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const a = ship({ mmsi: '1', name: 'ALPHA', lat: 68.7, lng: 15.4 });
        const b = ship({ mmsi: '2', name: 'BRAVO', lat: 68.7, lng: 15.41 });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(configuredResponse([a, b])))
            .mockResolvedValueOnce(jsonResponse(configuredResponse([a]))); // b aged out/gone
        vi.stubGlobal('fetch', fetchMock);
        const { map } = fakeMap();
        const createdMarkers: FakeMarker[] = [];
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet(createdPolygons, createdMarkers), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(createdMarkers).toHaveLength(1);
        createdMarkers[0]?.openPopup();

        await vi.advanceTimersByTimeAsync(10_000); // next poll: only `a` remains
        // The two-member badge is gone -- `a` now renders as an ordinary single triangle instead.
        expect(createdPolygons.length).toBeGreaterThan(0);

        dispose();
    });
});

/**
 * The two actions at the foot of a ship's popup. They are what the whole
 * follow feature is reached through, and one of them holds the kiosk's
 * slideshow -- so "does the button do the thing" is worth asserting from
 * the layer that builds it, not only from `follow.ts` in isolation.
 */
describe('mountShipsLayer -- the popup actions', () => {
    afterEach(() => {
        stopFollowing();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ ships: { enabled: false, pollSeconds: 10, maxAgeMinutes: 30 } }));
    });

    async function openShipPopup(): Promise<{
        buttons: HTMLButtonElement[];
        rebuild: () => HTMLButtonElement[];
        views: { lat: number; lng: number; zoom: number }[];
        dispose: () => void;
    }> {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([ship()]))));
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];
        const { map, views } = fakeMap();

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet(createdPolygons), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        // The popup is bound to the hit area -- the second of each glyph's
        // (visible, hitArea) pair.
        const [, hitArea] = createdPolygons;
        const rebuild = (): HTMLButtonElement[] => [...(hitArea?.popupContent?.().querySelectorAll('.vessel-action') ?? [])] as HTMLButtonElement[];
        return { buttons: rebuild(), rebuild, views, dispose };
    }

    it('offers exactly the two of them', async () => {
        const { buttons, dispose } = await openShipPopup();

        expect(buttons.map((button) => button.textContent)).toEqual(['Zoom inn', 'Følg']);

        dispose();
    });

    it('zooms to the ship without following it or touching the slideshow', async () => {
        const { buttons, views, dispose } = await openShipPopup();

        buttons[0]?.click();

        expect(views.at(-1)).toEqual({ lat: 68.7, lng: 15.4, zoom: VESSEL_ZOOM });
        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);

        dispose();
    });

    it('follows the ship by name, and holds the slideshow while it does', async () => {
        const { buttons, dispose } = await openShipPopup();

        buttons[1]?.click();

        expect(followTarget.get()).toEqual({ id: '257123456', label: 'MS NORDLYS', layer: 'ships' });
        expect(autoCycleHeld.get()).toBe(true);

        dispose();
    });

    it('offers to stop once it is the one being followed, and stops on the second tap', async () => {
        const { buttons, rebuild, dispose } = await openShipPopup();

        buttons[1]?.click();
        const nowFollowing = rebuild();
        expect(nowFollowing[1]?.textContent).toBe('Slutt å følge');

        nowFollowing[1]?.click();
        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);

        dispose();
    });

    it('lets go of a ship whose last fix has aged off the map', async () => {
        // `latestShips` holds the last good response even while the
        // upstream is down, so without the age filter the follow would
        // hold station over water with nothing drawn on it, under a chip
        // naming a ship nobody can see.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(configuredResponse([ship()]))));
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];
        const { map } = fakeMap();

        mockSettings.set(SettingsSchema.parse({ ships: { enabled: true, pollSeconds: 10, maxAgeMinutes: 30 } }));
        const dispose = mountShipsLayer(fakeLeaflet(createdPolygons), map, {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const [, hitArea] = createdPolygons;
        const buttons = [...(hitArea?.popupContent?.().querySelectorAll('.vessel-action') ?? [])] as HTMLButtonElement[];
        buttons[1]?.click();
        expect(followTarget.get()).not.toBeNull();

        // Past the 30-minute age filter, plus the follow's own 30s grace.
        await vi.advanceTimersByTimeAsync(31 * 60_000);
        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);

        dispose();
    });

    it('lets the slideshow go when the map page does, however the follow was left', async () => {
        // A follow is a property of this page being open. Leaving it while
        // still following must not strand the kiosk on a frozen timer.
        const { buttons, dispose } = await openShipPopup();

        buttons[1]?.click();
        expect(autoCycleHeld.get()).toBe(true);

        dispose();
        stopFollowing(); // what `mountLiveLayers`' own disposer does
        expect(autoCycleHeld.get()).toBe(false);
    });
});
