/**
 * `mountTransitLayer`'s client-side mode filters (`showBuses`/`showFerries`),
 * its reported count, and that a vehicle dropping out of a poll removes its
 * marker rather than leaving it stale -- same fake-`L`/`Leaflet.Map`
 * convention as `roads.test.ts`/`aircraft.test.ts`.
 *
 * `punctualityFor`/`isLateEnoughToTint` get their own block: the exact
 * three-way threshold logic this layer's pin colour and popup text are
 * both built from, exercised at every boundary directly, no map required.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({ transit: { enabled: false } }));
vi.mock('../../settings-resource.js', () => ({ settings: mockSettings }));

const { mountTransitLayer, punctualityFor, isLateEnoughToTint } = await import('./transit.js');

function enabled(overrides: Partial<Settings['transit']> = {}): Settings {
    return SettingsSchema.parse({
        transit: { enabled: true, pollSeconds: 15, maxAgeMinutes: 10, showBuses: true, showFerries: true, ...overrides },
    });
}

interface FakeMarker {
    latLng: unknown;
    icon: Record<string, unknown> | undefined;
    popupContent: (() => HTMLElement) | undefined;
    removed: boolean;
}

function fakeLeaflet(created: { markers: FakeMarker[] }): typeof Leaflet {
    const group = {
        addTo: () => group,
        addLayer: () => group,
        removeLayer: (layer: { removed?: boolean }) => {
            layer.removed = true;
            return group;
        },
    };
    return {
        layerGroup: () => group,
        divIcon: (options: Record<string, unknown>) => options,
        marker: (latLng: unknown, options: { icon: Record<string, unknown> }) => {
            const marker: FakeMarker & Record<string, unknown> = {
                latLng,
                icon: options.icon,
                popupContent: undefined,
                removed: false,
                addTo: () => marker,
                setLatLng: (next: unknown) => {
                    marker.latLng = next;
                    return marker;
                },
                setIcon: (next: Record<string, unknown>) => {
                    marker.icon = next;
                    return marker;
                },
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

const bus754 = {
    id: 'VYG:VehicleRef:1',
    mode: 'bus',
    line: 'Sortland-Stm.nes-Melbu-Svolvær',
    publicCode: '754',
    operatorRef: 'VYG',
    origin: 'Sortland',
    destination: 'Svolvær',
    delaySeconds: 20,
    point: { lat: 68.7, lng: 15.41 },
    recordedAt: '2026-09-16T12:00:00Z',
};

const ferry18 = {
    id: 'VYG:VehicleRef:2',
    mode: 'ferry',
    line: 'Melbu-Fiskebøl',
    publicCode: '18-703',
    operatorRef: 'TIDE',
    origin: 'Melbu',
    destination: 'Fiskebøl',
    delaySeconds: null,
    point: { lat: 68.5, lng: 14.78 },
    recordedAt: '2026-09-16T12:00:00Z',
};

function response(vehicles: unknown[]): unknown {
    return { configured: true, fetchedAt: '2026-09-16T12:00:00Z', vehicles };
}

describe('mountTransitLayer', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ transit: { enabled: false } }));
    });

    it('draws both a bus and a ferry pin, and reports their count', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([bus754, ferry18]))));
        const created = { markers: [] as FakeMarker[] };
        const reportCount = vi.fn();
        const reportAttribution = vi.fn();
        const reportItems = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountTransitLayer(fakeLeaflet(created), fakeMap(), { reportCount, reportAttribution, reportItems });
        await vi.advanceTimersByTimeAsync(0);

        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(2);
        expect(reportCount).toHaveBeenLastCalledWith(2, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith('Data: Entur');

        dispose();
        expect(reportCount).toHaveBeenLastCalledWith(0, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith(undefined);
    });

    it('hides buses/ferries the instant either checkbox is switched off, with no new fetch', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response([bus754, ferry18])));
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[] };
        const reportCount = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountTransitLayer(fakeLeaflet(created), fakeMap(), {
            reportCount,
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(2);
        const fetchCallsAfterFirstPoll = fetchMock.mock.calls.length;

        mockSettings.set(enabled({ showFerries: false }));
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(1);
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);

        mockSettings.set(enabled({ showBuses: false, showFerries: false }));
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(0);
        expect(reportCount).toHaveBeenLastCalledWith(0, 0);

        mockSettings.set(enabled());
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(2);

        // The filter is entirely client-side -- no extra request was made
        // for any of the toggles above.
        expect(fetchMock.mock.calls.length).toBe(fetchCallsAfterFirstPoll);

        dispose();
    });

    it('applies a settings.transit.pollSeconds change to subsequent polls immediately, not only after remount', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        // A fresh `Response` per call -- unlike every other test in this
        // file, this one polls more than once off the same mock, and a
        // `Response` body can only be read (`.json()`) once: reusing one
        // instance across calls would make the second/third poll fail
        // with a "body already read" error, which this layer's own
        // `resource()` backoff would then (correctly) read as a real
        // upstream failure and silently double the next interval --
        // exactly the kind of test bug that would make this test's own
        // interval assertions meaningless.
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(response([bus754]))));
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[] };

        mockSettings.set(enabled({ pollSeconds: 15 }));
        const dispose = mountTransitLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Rebuilding the underlying resource at the new interval fetches
        // once immediately, the same "a settings change is felt now, not
        // next poll" contract every other live-layer setting already gets
        // (`showBuses`/`showFerries` filter in place; `days` on the
        // species layer refetches) -- accounted for here before checking
        // the new *interval* takes effect below.
        mockSettings.set(enabled({ pollSeconds: 30 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // The OLD 15s interval must no longer govern -- advancing by
        // exactly that must not poll again.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // The full NEW 30s interval (since the change) does poll.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        dispose();
    });

    it('removes a marker whose vehicle disappears from a later poll, and updates one that persists', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        const movedBus = { ...bus754, point: { lat: 68.72, lng: 15.44 }, delaySeconds: 200 };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(response([bus754, ferry18])))
            .mockResolvedValue(jsonResponse(response([movedBus])));
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[] };
        const reportCount = vi.fn();

        mockSettings.set(enabled({ pollSeconds: 15 }));
        const dispose = mountTransitLayer(fakeLeaflet(created), fakeMap(), {
            reportCount,
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(created.markers).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(15_000);

        // Same marker object for the bus, updated in place -- not rebuilt.
        expect(created.markers).toHaveLength(2);
        const [busMarker, ferryMarker] = created.markers;
        expect(busMarker?.removed).toBe(false);
        expect(busMarker?.latLng).toEqual([68.72, 15.44]);
        expect(ferryMarker?.removed).toBe(true);
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);

        dispose();
    });

    it('shows the route line for both/only-origin/only-destination/neither, never dropping the one side that is present', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        const bothSides = bus754;
        const originOnly = { ...bus754, id: 'VYG:VehicleRef:3', destination: null, point: { lat: 68.6, lng: 15.3 } };
        const destinationOnly = { ...bus754, id: 'VYG:VehicleRef:4', origin: null, point: { lat: 68.55, lng: 15.2 } };
        const neither = { ...bus754, id: 'VYG:VehicleRef:5', origin: null, destination: null, point: { lat: 68.45, lng: 15.1 } };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([bothSides, originOnly, destinationOnly, neither]))));
        const created = { markers: [] as FakeMarker[] };

        mockSettings.set(enabled());
        const dispose = mountTransitLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        function routeTextFor(lat: number): string | null {
            const marker = created.markers.find((m) => (m.latLng as [number, number])[0] === lat);
            const popup = marker?.popupContent?.();
            return popup?.querySelector('.transit-popup-route')?.textContent ?? null;
        }

        expect(routeTextFor(68.7)).toBe('Sortland → Svolvær');
        expect(routeTextFor(68.6)).toBe('Fra Sortland');
        expect(routeTextFor(68.55)).toBe('Til Svolvær');
        expect(routeTextFor(68.45)).toBeNull();

        dispose();
    });
});

describe('punctualityFor', () => {
    it('is exact at every boundary', () => {
        expect(punctualityFor(-61)).toEqual({ kind: 'early', minutes: 1 });
        expect(punctualityFor(-60)).toEqual({ kind: 'onTime' });
        expect(punctualityFor(-59)).toEqual({ kind: 'onTime' });
        expect(punctualityFor(0)).toEqual({ kind: 'onTime' });
        expect(punctualityFor(60)).toEqual({ kind: 'onTime' });
        expect(punctualityFor(61)).toEqual({ kind: 'late', minutes: 1 });
        expect(punctualityFor(180)).toEqual({ kind: 'late', minutes: 3 });
        expect(punctualityFor(181)).toEqual({ kind: 'late', minutes: 3 });
        expect(punctualityFor(null)).toEqual({ kind: 'unknown' });
    });
});

describe('isLateEnoughToTint', () => {
    it('tints only past 180 seconds late, never for early or unknown', () => {
        expect(isLateEnoughToTint(-61)).toBe(false);
        expect(isLateEnoughToTint(-60)).toBe(false);
        expect(isLateEnoughToTint(0)).toBe(false);
        expect(isLateEnoughToTint(60)).toBe(false);
        expect(isLateEnoughToTint(61)).toBe(false);
        expect(isLateEnoughToTint(180)).toBe(false);
        expect(isLateEnoughToTint(181)).toBe(true);
        expect(isLateEnoughToTint(null)).toBe(false);
    });
});
