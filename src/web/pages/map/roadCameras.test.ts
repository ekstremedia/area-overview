/**
 * `mountRoadCamerasLayer`: the pins, the "a cluster is a site" grouping
 * that falls out of the generic `clustering.ts` for free, the gate on
 * both `roads.enabled` and `roads.showCameras`, and the fixed poll that
 * is deliberately *not* the user's `roads.pollSeconds`.
 *
 * Same fake-`L`/`Leaflet.Map` convention as `roads.test.ts`, plus
 * `project`/`unproject` (clustering works in screen pixels) and `on`,
 * since a road-camera pin opens a modal on click rather than binding a
 * popup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({ roads: { enabled: false } }));
vi.mock('../../settings-resource.js', () => ({ settings: mockSettings }));

const { mountRoadCamerasLayer, ROAD_CAMERAS_POLL_MS } = await import('./roadCameras.js');

function enabled(overrides: Partial<Settings['roads']> = {}): Settings {
    return SettingsSchema.parse({ roads: { enabled: true, pollSeconds: 120, showPlanned: false, showCameras: true, ...overrides } });
}

interface FakeMarker {
    latLng: unknown;
    icon: Record<string, unknown> | undefined;
    handlers: Map<string, () => void>;
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
        latLng: (lat: number, lng: number) => ({ lat, lng }),
        point: (x: number, y: number) => ({ x, y }),
        marker: (latLng: unknown, options: { icon: Record<string, unknown> }) => {
            const marker: FakeMarker & Record<string, unknown> = {
                latLng,
                icon: options.icon,
                handlers: new Map<string, () => void>(),
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
                on: (event: string, handler: () => void) => {
                    marker.handlers.set(event, handler);
                    return marker;
                },
            };
            created.markers.push(marker);
            return marker;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as typeof Leaflet;
}

/** A crude equirectangular projection: enough for "same coordinates land on the same pixel, 0.5° apart do not". */
function fakeMap(): Leaflet.Map {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1024 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    const map = {
        getZoom: () => 10,
        project: (at: { lat: number; lng: number }) => ({ x: at.lng * 1000, y: at.lat * 1000 }),
        unproject: (at: { x: number; y: number }) => ({ lat: at.y / 1000, lng: at.x / 1000 }),
        on: () => undefined,
        off: () => undefined,
        removeLayer: () => undefined,
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

/** Tjeldsundbrua øst: two orientations at byte-identical coordinates, which is what makes a cluster a site with no site-specific code. */
const tjeldsund1 = {
    id: '1900184_1',
    siteId: '1900184',
    name: 'Tjeldsundbrua øst',
    direction: 'Evenes',
    roadNumber: 'E10',
    lat: 68.55,
    lng: 16.45,
    imageUrl: 'https://kamera.atlas.vegvesen.no/api/images/1900184_1',
};
const tjeldsund2 = { ...tjeldsund1, id: '1900184_2', direction: 'Tjeldsundet' };

/** Hadselbrua: far enough away to stay its own pin at this zoom. */
const hadsel = {
    id: '3000957_1',
    siteId: '3000957',
    name: 'Hadselbrua',
    direction: null,
    roadNumber: 'R85',
    lat: 68.5,
    lng: 14.9,
    imageUrl: 'https://kamera.atlas.vegvesen.no/api/images/3000957_1',
};

function response(cameras: unknown[], weatherBySite: Record<string, unknown> = {}): unknown {
    return { cameras, weatherBySite, fetchedAt: '2026-09-13T12:00:00Z' };
}

const noopCallbacks = { reportCount: vi.fn(), reportAttribution: vi.fn(), reportItems: vi.fn() };

describe('mountRoadCamerasLayer', () => {
    afterEach(() => {
        document.querySelector('.road-camera-modal')?.remove();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ roads: { enabled: false } }));
    });

    it('draws one muted pin per camera, groups a site into one badge, and reports the camera count', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(response([tjeldsund1, tjeldsund2, hadsel])))),
        );
        const created = { markers: [] as FakeMarker[] };
        const reportCount = vi.fn();
        const reportAttribution = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountRoadCamerasLayer(fakeLeaflet(created), fakeMap(), { reportCount, reportAttribution, reportItems: vi.fn() });
        await vi.advanceTimersByTimeAsync(0);

        // Two markers for three cameras: the site's two orientations share
        // their coordinates exactly, so the generic clustering merges them
        // with no `siteId` logic anywhere in the layer.
        const live = created.markers.filter((marker) => !marker.removed);
        expect(live).toHaveLength(2);
        expect(live.every((marker) => marker.icon?.className === 'road-camera-pin')).toBe(true);

        // The count is cameras, not pins: the masthead answers "how many
        // road cameras are in view", not "how many things were drawn".
        expect(reportCount).toHaveBeenLastCalledWith(3, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith('Data: Statens vegvesen');

        dispose();
        expect(reportCount).toHaveBeenLastCalledWith(0, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith(undefined);
    });

    it('opens the picture from a lone pin and the grid from a cluster badge', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(response([tjeldsund1, tjeldsund2, hadsel])))),
        );
        const created = { markers: [] as FakeMarker[] };

        mockSettings.set(enabled());
        const dispose = mountRoadCamerasLayer(fakeLeaflet(created), fakeMap(), { ...noopCallbacks });
        await vi.advanceTimersByTimeAsync(0);

        const [cluster, lone] = created.markers;
        cluster?.handlers.get('click')?.();
        expect(document.querySelector('.road-camera-modal-grid')).not.toBeNull();
        expect(document.querySelectorAll('.road-camera-thumb')).toHaveLength(2);

        lone?.handlers.get('click')?.();
        expect(document.querySelector('.road-camera-modal-grid')).toBeNull();
        expect(document.querySelector<HTMLImageElement>('.road-camera-modal-image')?.src).toContain('3000957_1');
        expect(document.querySelector('.road-camera-modal-title')?.textContent).toBe('Hadselbrua');

        // Switching the layer off has to take the picture with it: the
        // modal is an overlay on `document.body`, not a child of anything
        // the map owns.
        dispose();
        expect(document.querySelector('.road-camera-modal')).toBeNull();
    });

    it('polls on its own fixed interval, not the user-tunable roads.pollSeconds', async () => {
        vi.useFakeTimers();
        // A factory, not a single resolved `Response`: a body can only be
        // read once, so a shared instance would make the second poll fail.
        const fetchMock = vi.fn((url: string) => {
            expect(url).toBe('/api/road-cameras?bbox=14.5,68.35,16.5,69.05');
            return Promise.resolve(jsonResponse(response([hadsel])));
        });
        vi.stubGlobal('fetch', fetchMock);

        // 60s: the shortest the settings page allows, and four minutes
        // short of what this layer actually uses.
        mockSettings.set(enabled({ pollSeconds: 60 }));
        const dispose = mountRoadCamerasLayer(fakeLeaflet({ markers: [] }), fakeMap(), { ...noopCallbacks });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(ROAD_CAMERAS_POLL_MS - 1000);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        dispose();
    });

    it('is gated on both the layer toggle and showCameras, and mounts/unmounts as either flips', async () => {
        vi.useFakeTimers();
        // A factory, not a single resolved `Response`: a body can only be
        // read once, so a shared instance would make the second poll fail.
        const fetchMock = vi.fn((url: string) => {
            expect(url).toBe('/api/road-cameras?bbox=14.5,68.35,16.5,69.05');
            return Promise.resolve(jsonResponse(response([hadsel])));
        });
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[] };
        const L = fakeLeaflet(created);
        const map = fakeMap();

        // The Veg layer is on, but its cameras are not.
        mockSettings.set(enabled({ showCameras: false }));
        const dispose = mountRoadCamerasLayer(L, map, { ...noopCallbacks });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).not.toHaveBeenCalled();

        mockSettings.set(enabled());
        await vi.advanceTimersByTimeAsync(0);
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(1);

        // Turning the whole layer off takes the cameras with it, even
        // though `showCameras` is still true.
        mockSettings.set(enabled({ enabled: false }));
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(0);

        dispose();
    });

    it('diffs pins by camera id across polls rather than rebuilding them', async () => {
        vi.useFakeTimers();
        const moved = { ...hadsel, lat: 68.51 };
        let poll = 0;
        const fetchMock = vi.fn(() => {
            poll += 1;
            return Promise.resolve(jsonResponse(response([poll === 1 ? hadsel : moved])));
        });
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[] };

        mockSettings.set(enabled());
        const dispose = mountRoadCamerasLayer(fakeLeaflet(created), fakeMap(), { ...noopCallbacks });
        await vi.advanceTimersByTimeAsync(0);
        expect(created.markers).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(ROAD_CAMERAS_POLL_MS);

        // Same marker, moved -- not a second one created and the first
        // thrown away.
        expect(created.markers).toHaveLength(1);
        expect(created.markers[0]?.latLng).toEqual([68.51, 14.9]);

        dispose();
    });
});
