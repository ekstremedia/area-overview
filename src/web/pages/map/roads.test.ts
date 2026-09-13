/**
 * `mountRoadsLayer`'s client-side `showPlanned` filter, its reported
 * count, the casing+core line it draws only where an extent means
 * something, and the verbatim Norwegian description in the English UI --
 * same fake-`L`/`Leaflet.Map` convention as `ships.test.ts`/
 * `aircraft.test.ts`.
 *
 * The vendored sign artwork gets its own block at the bottom: the files
 * were optimised by hand (`signs/README.md`), and "still valid XML, still
 * carrying its path data" is exactly the kind of thing an optimiser
 * quietly breaks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({ roads: { enabled: false } }));
vi.mock('../../settings-resource.js', () => ({ settings: mockSettings }));

const { mountRoadsLayer } = await import('./roads.js');

function enabled(overrides: Partial<Settings['roads']> = {}): Settings {
    return SettingsSchema.parse({ roads: { enabled: true, pollSeconds: 120, showPlanned: false, showCameras: true, ...overrides } });
}

interface FakePolyline {
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

function fakeLeaflet(created: { markers: FakeMarker[]; polylines: FakePolyline[] }): typeof Leaflet {
    const group = {
        addTo: () => group,
        addLayer: () => group,
        removeLayer: (layer: { removed?: boolean }) => {
            layer.removed = true;
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
        polyline: (latLngs: unknown, options: Record<string, unknown>) => {
            const line: FakePolyline & Record<string, unknown> = {
                latLngs,
                options,
                popupContent: undefined,
                removed: false,
                addTo: () => line,
                setStyle: (next: Record<string, unknown>) => {
                    line.options = { ...line.options, ...next };
                    return line;
                },
                setLatLngs: (next: unknown) => {
                    line.latLngs = next;
                    return line;
                },
                bindPopup: (content: () => HTMLElement) => {
                    line.popupContent = content;
                    return line;
                },
                isPopupOpen: () => false,
                setPopupContent: () => line,
            };
            created.polylines.push(line);
            return line;
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

/** Sortlandsbrua roadworks: in force, periodic, with an extent. */
const roadworks = {
    id: 'NPRA_1',
    kind: 'roadworks',
    rawType: 'MaintenanceWorks',
    severity: 'low',
    status: 'current',
    closed: false,
    effects: ['narrowLanes'],
    roadNumber: 'R85',
    location: 'Sortlandsbrua',
    description: 'Vegarbeid på Sortlandsbrua.\nManuell dirigering.',
    startsAt: '2026-09-13T06:00:00Z',
    endsAt: '2026-09-20T06:00:00Z',
    updatedAt: '2026-09-13T11:58:00Z',
    periodic: true,
    point: { lat: 68.7, lng: 15.41 },
    line: [
        [
            [68.7, 15.41],
            [68.71, 15.42],
        ],
    ],
};

/** Glåmvika: the road is shut, so the pin is 302 and the line is red. */
const closure = {
    ...roadworks,
    id: 'NPRA_2',
    kind: 'obstruction',
    rawType: 'EnvironmentalObstruction',
    closed: true,
    effects: ['roadClosed'],
    roadNumber: 'F7542',
    location: 'Glåmvika',
    description: 'Fv. 7542 er stengt ved Glåmvika.',
    periodic: false,
};

/** Tjeldsundbrua wind warning: upstream carries its geometry, the server sends no line for it, and it stays a pin. */
const windWarning = {
    ...roadworks,
    id: 'NPRA_3',
    kind: 'weather',
    rawType: 'PoorEnvironmentConditions',
    closed: false,
    effects: [],
    roadNumber: 'E10',
    location: 'Tjeldsundbrua',
    description: 'Sterk vind. Fare for at kjøretøy kan velte.',
    periodic: false,
    line: null,
};

/** Sløverfjordtunnelen: starts next week, hidden unless `showPlanned`. */
const planned = {
    ...roadworks,
    id: 'NPRA_4',
    status: 'planned',
    location: 'Sløverfjordtunnelen',
    startsAt: '2026-09-20T06:00:00Z',
    line: null,
};

/** Today's roadworks, currently outside their own 08-21 validity period. */
const scheduled = { ...roadworks, id: 'NPRA_5', status: 'scheduled', location: 'Kvitnes', line: null };

function response(situations: unknown[]): unknown {
    return { configured: true, fetchedAt: '2026-09-13T12:00:00Z', situations };
}

describe('mountRoadsLayer', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ roads: { enabled: false } }));
    });

    it('hides scheduled and planned situations until showPlanned is on, and reports the visible count', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([roadworks, planned, scheduled]))));
        const created = { markers: [] as FakeMarker[], polylines: [] as FakePolyline[] };
        const reportCount = vi.fn();
        const reportAttribution = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountRoadsLayer(fakeLeaflet(created), fakeMap(), { reportCount, reportAttribution, reportItems: vi.fn() });
        await vi.advanceTimersByTimeAsync(0);

        // Only the one in force: the response carries all three so that a
        // single server cache entry serves both preferences.
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(1);
        expect(reportAttribution).toHaveBeenLastCalledWith('Data: Statens vegvesen');

        // Flipping the setting re-filters what is already on screen, with
        // no second fetch and no wait for the 120s poll.
        mockSettings.set(enabled({ showPlanned: true }));
        expect(reportCount).toHaveBeenLastCalledWith(3, 0);
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(3);

        mockSettings.set(enabled({ showPlanned: false }));
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);
        expect(created.markers.filter((marker) => !marker.removed)).toHaveLength(1);

        dispose();
        expect(reportCount).toHaveBeenLastCalledWith(0, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith(undefined);
    });

    it('draws a dark casing under a coloured core for a closure, and no line at all for a wind warning', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([closure, windWarning]))));
        const created = { markers: [] as FakeMarker[], polylines: [] as FakePolyline[] };

        mockSettings.set(enabled());
        const dispose = mountRoadsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        // Two pins, but only the closure has an extent: the wind warning's
        // own geometry never leaves the BFF, so nothing here can draw it.
        expect(created.markers).toHaveLength(2);
        expect(created.polylines).toHaveLength(2);

        const [casing, core] = created.polylines;
        expect(casing?.options.weight).toBe(7);
        expect(casing?.options.color).toBe('#16191c');
        // Scenery: it must never take the tap the core is there to receive.
        expect(casing?.options.interactive).toBe(false);
        expect(core?.options.weight).toBe(4);
        expect(core?.options.color).toBe('#e23c2e'); // closed, so red
        expect(core?.options.dashArray).toBeUndefined(); // in force, so solid
        // Both go through the map's one shared canvas (`canvasRenderer.ts`).
        expect(casing?.options.renderer).toBe(core?.options.renderer);
        // The line answers the same question the pin does.
        expect(core?.popupContent).toBeTypeOf('function');

        dispose();
    });

    it('dashes the core of a line that is not in force right now', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
        const plannedWithLine = { ...roadworks, id: 'NPRA_6', status: 'planned' };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([plannedWithLine]))));
        const created = { markers: [] as FakeMarker[], polylines: [] as FakePolyline[] };

        mockSettings.set(enabled({ showPlanned: true }));
        const dispose = mountRoadsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const core = created.polylines[1];
        expect(core?.options.color).toBe('#9aa4ad'); // grey: not in force
        expect(core?.options.dashArray).toBe('10 8');

        dispose();
    });

    it('shows Vegvesen’s Norwegian description verbatim under the English UI, with a source line under it', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([closure]))));
        const created = { markers: [] as FakeMarker[], polylines: [] as FakePolyline[] };

        mockSettings.set({ ...enabled(), language: 'en' });
        const dispose = mountRoadsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const popup = created.markers[0]?.popupContent?.();
        expect(popup).toBeDefined();
        // NPRA's terms: the Norwegian messages may not be translated.
        expect(popup?.querySelector('.road-popup-description')?.textContent).toBe('Fv. 7542 er stengt ved Glåmvika.');
        // ...so the English UI names the source, and the paragraph above
        // reads as a quotation rather than as a broken language switch.
        expect(popup?.querySelector('.road-popup-source')?.textContent).toBe('Statens vegvesen');
        // The rest of the popup *is* translated.
        expect(popup?.querySelector('.road-popup-kind')?.textContent).toBe('Obstruction');
        expect(popup?.querySelector('.road-popup-where')?.textContent).toBe('Fv. 7542 · Glåmvika');
        expect(popup?.querySelector('.road-popup-effect')?.textContent).toBe('Road closed');

        dispose();
    });

    it('leaves the source line out of the Norwegian UI, where the description is already in the reader’s language', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([closure]))));
        const created = { markers: [] as FakeMarker[], polylines: [] as FakePolyline[] };

        mockSettings.set(enabled());
        const dispose = mountRoadsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const popup = created.markers[0]?.popupContent?.();
        expect(popup?.querySelector('.road-popup-source')).toBeNull();
        expect(popup?.querySelector('.road-popup-kind')?.textContent).toBe('Hindring');

        dispose();
    });

    it('puts the closure sign on a closed road whatever caused it, and the roadworks sign on roadworks', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([roadworks, closure, windWarning]))));
        const created = { markers: [] as FakeMarker[], polylines: [] as FakePolyline[] };

        mockSettings.set(enabled());
        const dispose = mountRoadsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const plateOf = (marker: FakeMarker | undefined): HTMLElement => marker?.icon?.html as HTMLElement;
        // The sign faces differ per kind, and the closure's differs from
        // the roadworks' even though its own cause is an obstruction.
        const [works, shut, wind] = created.markers.map((marker) => plateOf(marker).innerHTML);
        expect(works).not.toBe(shut);
        expect(shut).not.toBe(wind);
        expect(works).not.toBe(wind);
        // Colour carries state independently of the sign.
        expect(plateOf(created.markers[0]).style.getPropertyValue('--road-situation-color')).toBe('#f0a020');
        expect(plateOf(created.markers[1]).style.getPropertyValue('--road-situation-color')).toBe('#e23c2e');

        dispose();
    });

    it('moves and restyles an existing pin across polls instead of rebuilding the layer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
        const movedAndClosed = { ...roadworks, closed: true, effects: ['roadClosed'], point: { lat: 68.75, lng: 15.5 } };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(response([roadworks])))
            .mockResolvedValue(jsonResponse(response([movedAndClosed])));
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[], polylines: [] as FakePolyline[] };

        mockSettings.set(enabled());
        const dispose = mountRoadsLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(120_000);

        // Same marker object, updated in place -- an open popup survives a
        // poll, and the map does not flicker every two minutes.
        expect(created.markers).toHaveLength(1);
        expect(created.markers[0]?.latLng).toEqual([68.75, 15.5]);
        expect((created.markers[0]?.icon?.html as HTMLElement).style.getPropertyValue('--road-situation-color')).toBe('#e23c2e');
        // Geometry unchanged, so the same two polylines were restyled.
        expect(created.polylines).toHaveLength(2);
        expect(created.polylines[1]?.options.color).toBe('#e23c2e');

        dispose();
    });
});

describe('vendored sign artwork', () => {
    it('is valid XML with its viewBox kept, its intrinsic size dropped and its path data intact', async () => {
        const signs = await Promise.all([
            import('./signs/110.svg?raw'),
            import('./signs/302.svg?raw'),
            import('./signs/775.svg?raw'),
            import('./signs/156.svg?raw'),
        ]);

        for (const module of signs) {
            const source: string = module.default;
            const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
            expect(parsed.querySelector('parsererror')).toBeNull();

            const svg = parsed.documentElement;
            expect(svg.tagName).toBe('svg');
            // Sized by CSS at 26px (pin) and 48px (popup); an intrinsic
            // width/height would fight that.
            expect(svg.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/);
            expect(svg.hasAttribute('width')).toBe(false);
            expect(svg.hasAttribute('height')).toBe(false);

            // The faces are traced outlines: paths with real `d` data and a
            // fill, which is all there is to lose.
            const paths = [...parsed.querySelectorAll('path')];
            expect(paths.length).toBeGreaterThan(0);
            for (const path of paths) {
                expect(path.getAttribute('d')?.length ?? 0).toBeGreaterThan(20);
                expect(path.getAttribute('fill')).toMatch(/^#[0-9a-f]{6}$/);
            }
        }
    });
});
