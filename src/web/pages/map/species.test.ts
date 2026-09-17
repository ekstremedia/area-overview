/**
 * `mountSpeciesLayer`'s vernacular-name fallback (rendered in italics, not
 * a blank line or the literal word "null"), the documented glyph fallback
 * for an unrecognised `class`, the client-side `animalsOnly` filter, the
 * reported count following what is actually drawn, and the `truncated`
 * caveat changing the reported attribution -- same fake-`L`/`Leaflet.Map`
 * convention as `transit.test.ts`/`warnings.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({ species: { enabled: false } }));
vi.mock('../../settings-resource.js', () => ({ settings: mockSettings }));

const { mountSpeciesLayer } = await import('./species.js');

function enabled(overrides: Partial<Settings['species']> = {}): Settings {
    return SettingsSchema.parse({
        species: { enabled: true, pollSeconds: 1800, days: 30, animalsOnly: false, ...overrides },
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
        clearLayers: () => {
            for (const marker of created.markers) marker.removed = true;
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

const vannmiljoFish = {
    id: 'gbif:2345:68.700:15.410',
    scientificName: 'Salmo salar',
    vernacularName: null,
    kingdom: 'Animalia',
    class: 'Actinopterygii',
    datasets: [{ key: 'ds-1', title: 'Vannmiljø' }],
    license: 'http://creativecommons.org/licenses/by-nc/4.0/legalcode',
    coordinateUncertaintyMeters: null,
    count: 1,
    individualCount: null,
    point: { lat: 68.7, lng: 15.41 },
    observedAt: '2026-08-01T00:00:00Z',
};

const gullBird = {
    id: 'gbif:1234:68.71:15.42',
    scientificName: 'Larus argentatus',
    vernacularName: 'Gråmåke',
    kingdom: 'Animalia',
    class: 'Aves',
    datasets: [{ key: 'ds-2', title: 'Artsobservasjoner' }],
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    coordinateUncertaintyMeters: 300,
    count: 4,
    individualCount: 12,
    point: { lat: 68.71, lng: 15.42 },
    observedAt: '2026-09-10T00:00:00Z',
};

const unfamiliarClassRecord = {
    id: 'gbif:9999:68.72:15.43',
    scientificName: 'Fungimystus obscurus',
    vernacularName: null,
    kingdom: 'Fungi',
    class: 'Agaricomycetes',
    datasets: [{ key: 'ds-3', title: 'GBIF Backbone' }],
    license: 'http://creativecommons.org/licenses/by/4.0/legalcode',
    coordinateUncertaintyMeters: null,
    count: 1,
    individualCount: null,
    point: { lat: 68.72, lng: 15.43 },
    observedAt: '2026-09-01T00:00:00Z',
};

function response(sightings: unknown[], truncated = false): unknown {
    return { configured: true, fetchedAt: '2026-09-16T12:00:00Z', truncated, sightings };
}

describe('mountSpeciesLayer', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ species: { enabled: false } }));
    });

    it('shows the scientific name in italics when GBIF gave no vernacular name, and the reported count matches what is drawn', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([vannmiljoFish, gullBird]))));
        const created = { markers: [] as FakeMarker[] };
        const reportCount = vi.fn();
        const reportAttribution = vi.fn();
        const reportItems = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountSpeciesLayer(fakeLeaflet(created), fakeMap(), { reportCount, reportAttribution, reportItems });
        await vi.advanceTimersByTimeAsync(0);

        const live = created.markers.filter((marker) => !marker.removed);
        expect(live).toHaveLength(2);
        expect(reportCount).toHaveBeenLastCalledWith(2, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith('Data: GBIF');

        const fishMarker = live.find((marker) => marker.latLng && (marker.latLng as [number, number])[0] === 68.7);
        const popup = fishMarker?.popupContent?.();
        expect(popup).toBeDefined();
        const scientificNameEl = popup?.querySelector('.species-popup-scientific-name');
        expect(scientificNameEl?.tagName).toBe('I');
        expect(scientificNameEl?.textContent).toBe('Salmo salar');
        // Never a blank heading and never the literal word "null".
        expect(popup?.querySelector('.species-popup-heading')?.textContent).not.toBe('');
        expect(popup?.textContent).not.toContain('null');

        dispose();
        expect(reportCount).toHaveBeenLastCalledWith(0, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith(undefined);
    });

    it('shows the vernacular name plainly (no italics) when GBIF gave one', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([gullBird]))));
        const created = { markers: [] as FakeMarker[] };

        mockSettings.set(enabled());
        const dispose = mountSpeciesLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const marker = created.markers.find((m) => !m.removed);
        const popup = marker?.popupContent?.();
        expect(popup?.querySelector('.species-popup-heading')?.textContent).toBe('Gråmåke');
        expect(popup?.querySelector('.species-popup-scientific-name')).toBeNull();

        dispose();
    });

    it('falls back to the generic glyph for a class it does not recognise', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([unfamiliarClassRecord]))));
        const created = { markers: [] as FakeMarker[] };

        // `animalsOnly` off, since this record's kingdom is `Fungi` and
        // this test is about the glyph fallback, not the kingdom filter.
        mockSettings.set(enabled());
        const dispose = mountSpeciesLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        const marker = created.markers.find((m) => !m.removed);
        const icon = marker?.icon as { html: HTMLElement } | undefined;
        const glyph = icon?.html.querySelector('.species-pin-glyph');
        // The fallback SVG (`glyphs/organism.svg`) draws a `<circle>` at
        // its centre; none of the five named class glyphs do.
        expect(glyph?.querySelector('circle')).not.toBeNull();

        dispose();
    });

    it('hides a non-Animalia sighting the instant animalsOnly is switched on, with no new fetch, and shows it again when switched off', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response([vannmiljoFish, unfamiliarClassRecord])));
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[] };
        const reportCount = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountSpeciesLayer(fakeLeaflet(created), fakeMap(), {
            reportCount,
            reportAttribution: vi.fn(),
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(created.markers.filter((m) => !m.removed)).toHaveLength(2);
        const fetchCallsAfterFirstPoll = fetchMock.mock.calls.length;

        mockSettings.set(enabled({ animalsOnly: true }));
        expect(created.markers.filter((m) => !m.removed)).toHaveLength(1);
        expect(reportCount).toHaveBeenLastCalledWith(1, 0);

        mockSettings.set(enabled({ animalsOnly: false }));
        expect(created.markers.filter((m) => !m.removed)).toHaveLength(2);
        expect(reportCount).toHaveBeenLastCalledWith(2, 0);

        // The filter is entirely client-side -- no extra request was made
        // for either toggle.
        expect(fetchMock.mock.calls.length).toBe(fetchCallsAfterFirstPoll);

        dispose();
    });

    it('appends the truncation caveat to the reported attribution only when the server says the response was capped', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response([gullBird], true)));
        vi.stubGlobal('fetch', fetchMock);
        const created = { markers: [] as FakeMarker[] };
        const reportAttribution = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountSpeciesLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution,
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(reportAttribution).toHaveBeenLastCalledWith('Data: GBIF (viser et utvalg)');

        dispose();
    });

    it('reports the plain attribution, with no caveat, when the response was not truncated', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response([gullBird], false))));
        const created = { markers: [] as FakeMarker[] };
        const reportAttribution = vi.fn();

        mockSettings.set(enabled());
        const dispose = mountSpeciesLayer(fakeLeaflet(created), fakeMap(), {
            reportCount: vi.fn(),
            reportAttribution,
            reportItems: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(reportAttribution).toHaveBeenLastCalledWith('Data: GBIF');

        dispose();
    });
});
