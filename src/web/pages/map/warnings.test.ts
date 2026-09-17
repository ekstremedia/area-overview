/**
 * `mountWarningsLayer`'s wholesale-rebuild render: one polygon drawn per
 * weather warning's own polygon ring, one outline+pin per avalanche
 * region, an absent avalanche pin when the response carries none, and the
 * documented fallback colour for an `awarenessLevel` this app does not
 * recognise -- same fake-`L`/`Leaflet.Map` convention as
 * `roads.test.ts`/`transit.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import { WARNING_ORANGE_COLOR, WARNING_RED_COLOR, WARNING_UNKNOWN_COLOR, WARNING_YELLOW_COLOR } from './liveLayerColors.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({ warnings: { enabled: false } }));
vi.mock('../../settings-resource.js', () => ({ settings: mockSettings }));

const { mountWarningsLayer } = await import('./warnings.js');

function enabled(overrides: Partial<Settings['warnings']> = {}): Settings {
    return SettingsSchema.parse({ warnings: { enabled: true, pollSeconds: 600, showAvalanche: true, ...overrides } });
}

interface FakePolygon {
    latLngs: unknown;
    options: Record<string, unknown>;
    popupContent: (() => HTMLElement) | undefined;
    removed: boolean;
}

interface FakeMarker {
    latLng: unknown;
    icon: Record<string, unknown> | undefined;
    popupContent: (() => HTMLElement) | undefined;
    removed: boolean;
}

function fakeLeaflet(created: { markers: FakeMarker[]; polygons: FakePolygon[] }): typeof Leaflet {
    const group = {
        addTo: () => group,
        addLayer: () => group,
        removeLayer: (layer: { removed?: boolean }) => {
            layer.removed = true;
            return group;
        },
        clearLayers: () => {
            for (const marker of created.markers) marker.removed = true;
            for (const polygon of created.polygons) polygon.removed = true;
            return group;
        },
    };
    return {
        canvas: () => ({}),
        layerGroup: () => group,
        divIcon: (options: Record<string, unknown>) => options,
        marker: (latLng: unknown, options: { icon: Record<string, unknown> }) => {
            const marker: FakeMarker & Record<string, unknown> = {
                latLng,
                icon: options.icon,
                popupContent: undefined,
                removed: false,
                addTo: () => marker,
                bindPopup: (content: () => HTMLElement) => {
                    marker.popupContent = content;
                    return marker;
                },
                isPopupOpen: () => false,
                setPopupContent: () => marker,
            };
            created.markers.push(marker);
            return marker;
        },
        polygon: (latLngs: unknown, options: Record<string, unknown>) => {
            const polygon: FakePolygon & Record<string, unknown> = {
                latLngs,
                options,
                popupContent: undefined,
                removed: false,
                addTo: () => polygon,
                bindPopup: (content: () => HTMLElement) => {
                    polygon.popupContent = content;
                    return polygon;
                },
                isPopupOpen: () => false,
                setPopupContent: () => polygon,
            };
            created.polygons.push(polygon);
            return polygon;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as typeof Leaflet;
}

function fakeMap(): Leaflet.Map {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1024 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    const map = {
        getZoom: () => 10,
        on: () => undefined,
        off: () => undefined,
        removeLayer: () => undefined,
        closePopup: () => map,
        getBounds: () => ({ getWest: () => 14.5, getSouth: () => 68.35, getEast: () => 16.5, getNorth: () => 69.05 }),
        getContainer: () => container,
        getSize: () => ({ x: 1024, y: 600 }),
        invalidateSize: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Leaflet.Map;
    return map;
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A gale warning MET colours orange. Lowercase, matching
 * `extractAwarenessLevel`'s (`met-alerts.ts`) actual wire format -- a
 * capitalised fixture here previously hid the case mismatch this file's
 * `colorForAwareness` had against the real server output.
 */
const galeWarning = {
    id: 'MET-1',
    event: 'gale',
    awarenessLevel: 'orange',
    title: 'Kuling',
    description: 'Kraftig kuling ventet i kastene.',
    consequences: null,
    instruction: null,
    area: 'Vesterålen',
    polygon: [
        [
            [68.6, 15.0],
            [68.7, 15.2],
            [68.65, 15.4],
        ],
    ],
    startsAt: '2026-09-16T06:00:00Z',
    endsAt: '2026-09-16T18:00:00Z',
};

/** An ice warning carrying an `awarenessLevel` this app has never heard of. */
const iceWarningUnknownLevel = {
    ...galeWarning,
    id: 'MET-2',
    event: 'ice',
    awarenessLevel: 'purple',
    title: 'Ising',
    description: 'Fare for ising på veier og luftledninger.',
    consequences: 'Glatte veier og brudd i strømnettet er mulig.',
    instruction: 'Kjør forsiktig og unngå unødvendig ferdsel.',
    endsAt: null,
};

/** Lofoten, danger level 3 -- orange on the European avalanche scale. */
const lofotenRegion = {
    regionId: 'NVE-3003',
    regionName: 'Lofoten',
    dangerLevel: 3,
    validAt: '2026-09-16T06:00:00Z',
    outline: [
        [68.2, 14.0],
        [68.3, 14.2],
        [68.25, 14.4],
    ],
    point: { lat: 68.25, lng: 14.2 },
};

function response(weatherWarnings: unknown[] | null, avalancheWarnings: unknown[] | null): unknown {
    return { configured: true, fetchedAt: '2026-09-16T12:00:00Z', weatherWarnings, avalancheWarnings };
}

describe('mountWarningsLayer', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ warnings: { enabled: false } }));
    });

    it('draws one polygon per weather warning and one outline+pin per avalanche region, and reports their combined count', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([galeWarning], [lofotenRegion]))));
        const created = { markers: [] as FakeMarker[], polygons: [] as FakePolygon[] };
        const reportCount = vi.fn();
        const reportAttribution = vi.fn();
        const reportItems = vi.fn();
        const reportColor = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountWarningsLayer(fakeLeaflet(created), fakeMap(), { reportCount, reportAttribution, reportItems, reportColor });
        await vi.advanceTimersByTimeAsync(0);

        // One weather polygon (filled) and one avalanche outline (not
        // filled), plus one avalanche pin.
        const live = created.polygons.filter((polygon) => !polygon.removed);
        expect(live).toHaveLength(2);
        const weatherPolygons = live.filter((polygon) => polygon.options.fill !== false);
        const avalancheOutlines = live.filter((polygon) => polygon.options.fill === false);
        expect(weatherPolygons).toHaveLength(1);
        expect(avalancheOutlines).toHaveLength(1);
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(1);

        expect(reportCount).toHaveBeenLastCalledWith(2, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith('Data: MET Norway / NVE');
        // orange (the gale) and orange (Lofoten's level 3) -- the worst
        // active colour is orange either way.
        expect(reportColor).toHaveBeenLastCalledWith(WARNING_ORANGE_COLOR);

        dispose();
        expect(reportCount).toHaveBeenLastCalledWith(0, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith(undefined);
        expect(reportColor).toHaveBeenLastCalledWith(null);
    });

    it('draws no avalanche pin when the response carries no avalanche regions', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([galeWarning], []))));
        const created = { markers: [] as FakeMarker[], polygons: [] as FakePolygon[] };
        const reportCount = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountWarningsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount,
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(0);
        expect(created.polygons.filter((polygon) => !polygon.removed)).toHaveLength(1);
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);

        dispose();
    });

    it('falls back to the documented colour for an awarenessLevel it does not recognise, without crashing', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([iceWarningUnknownLevel], []))));
        const created = { markers: [] as FakeMarker[], polygons: [] as FakePolygon[] };

        mockSettings.set(enabled());
        const dispose = mountWarningsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const [polygon] = created.polygons;
        expect(polygon?.options.color).toBe(WARNING_UNKNOWN_COLOR);
        expect(polygon?.options.fillColor).toBe(WARNING_UNKNOWN_COLOR);

        dispose();
    });

    it('colours a lowercase awarenessLevel correctly instead of falling back to the unknown colour (regression: server sends lowercase, the map was keyed capitalised)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        const yellowWarning = { ...galeWarning, id: 'MET-3', awarenessLevel: 'yellow' };
        const redWarning = { ...galeWarning, id: 'MET-4', awarenessLevel: 'red' };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([yellowWarning, redWarning], []))));
        const created = { markers: [] as FakeMarker[], polygons: [] as FakePolygon[] };

        mockSettings.set(enabled());
        const dispose = mountWarningsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const [yellowPolygon, redPolygon] = created.polygons;
        expect(yellowPolygon?.options.color).toBe(WARNING_YELLOW_COLOR);
        expect(yellowPolygon?.options.color).not.toBe(WARNING_UNKNOWN_COLOR);
        expect(redPolygon?.options.color).toBe(WARNING_RED_COLOR);
        expect(redPolygon?.options.color).not.toBe(WARNING_UNKNOWN_COLOR);

        dispose();
    });

    it('does not let one half of a poll being null suppress the other half', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response(null, [lofotenRegion]))));
        const created = { markers: [] as FakeMarker[], polygons: [] as FakePolygon[] };
        const reportCount = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountWarningsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount,
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        // MET failed this poll (`null`), but NVE's region still draws.
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(1);
        expect(created.polygons.filter((polygon) => !polygon.removed)).toHaveLength(1);
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);

        dispose();
    });

    it('hides avalanche outlines and pins the instant showAvalanche is switched off, with no new fetch', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response([galeWarning], [lofotenRegion])));
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[], polygons: [] as FakePolygon[] };
        const reportCount = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountWarningsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount,
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(1);
        const fetchCallsAfterFirstPoll = fetchMock.mock.calls.length;

        mockSettings.set(enabled({ showAvalanche: false }));
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(0);
        expect(created.polygons.filter((polygon) => !polygon.removed)).toHaveLength(1); // the weather polygon stays
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);

        // The filter is entirely client-side -- no extra request.
        expect(fetchMock.mock.calls.length).toBe(fetchCallsAfterFirstPoll);

        dispose();
    });

    it('applies a settings.warnings.pollSeconds change to subsequent polls immediately, not only after remount', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        // A fresh `Response` per call -- see `transit.test.ts`'s identical
        // test for why `mockResolvedValue` (one shared, single-read body)
        // would be wrong here.
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(response([galeWarning], [lofotenRegion]))));
        vi.stubGlobal('fetch', fetchMock);

        mockSettings.set(enabled({ pollSeconds: 300 }));
        const dispose = mountWarningsLayer(fakeLeaflet({ markers: [], polygons: [] }), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Rebuilding the underlying resource at the new interval fetches
        // once immediately (the same "felt now" contract every other
        // live-layer setting already gets) -- accounted for here before
        // checking the new *interval* takes effect below.
        mockSettings.set(enabled({ pollSeconds: 600 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // The OLD 300s interval must no longer govern.
        await vi.advanceTimersByTimeAsync(300_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // The full NEW 600s interval (since the change) does poll.
        await vi.advanceTimersByTimeAsync(300_000);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        dispose();
    });
});
