/**
 * `mountAircraftLayer`'s reactive mount/unmount, poll-floor clamping and
 * the `showOnGround` filter -- same fake-`L`/`Leaflet.Map` convention as
 * `ships.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({ aircraft: { enabled: false, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: false } }));
vi.mock('../../settings-resource.js', () => ({ settings: mockSettings }));

const { mountAircraftLayer } = await import('./aircraft.js');

function fakePolygon() {
    const polygon = {
        tooltip: undefined as HTMLElement | undefined,
        addTo: () => polygon,
        setLatLngs: () => polygon,
        setStyle: () => polygon,
        bindPopup: () => polygon,
        isPopupOpen: () => false,
        setPopupContent: () => polygon,
        bindTooltip: (content: HTMLElement) => {
            polygon.tooltip = content;
            return polygon;
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
    const group = { addTo: () => group, addLayer: () => group, removeLayer: () => group };
    return group;
}

function fakeLeaflet(createdPolygons: ReturnType<typeof fakePolygon>[] = []): typeof Leaflet {
    return {
        canvas: () => ({}),
        layerGroup: fakeLayerGroup,
        polygon: () => {
            const polygon = fakePolygon();
            createdPolygons.push(polygon);
            return polygon;
        },
        latLng: (lat: number, lng: number) => ({ lat, lng }),
        point: (x: number, y: number) => ({ x, y }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as typeof Leaflet;
}

function fakeMap(): Leaflet.Map {
    return {
        getZoom: () => 10,
        project: () => ({ x: 0, y: 0 }),
        unproject: () => ({ lat: 0, lng: 0 }),
        on: () => undefined,
        off: () => undefined,
        removeLayer: () => undefined,
        getBounds: () => ({ getWest: () => 14.0, getSouth: () => 68.0, getEast: () => 16.0, getNorth: () => 69.0 }),
        // See `ships.test.ts`'s fake: `mapToBboxQuery` skips a viewport it
        // cannot measure, so the fake has to have a real size.
        getContainer: () => ({ clientWidth: 1000, clientHeight: 600 }),
        getSize: () => ({ x: 1000, y: 600 }),
        invalidateSize: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Leaflet.Map;
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const oneAircraft = {
    configured: true,
    fetchedAt: '2026-09-05T12:00:00Z',
    aircraft: [
        {
            icao: 'abc123',
            callsign: 'TEST01',
            lat: 68.5,
            lng: 15.5,
            altitudeFt: 1000,
            groundSpeedKt: 100,
            track: 90,
            timestamp: '2026-09-05T12:00:00Z',
        },
    ],
};

describe('mountAircraftLayer', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ aircraft: { enabled: false, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: false } }));
    });

    it('clamps a configured pollSeconds below the hard floor up to 5s', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ configured: false }));
        vi.stubGlobal('fetch', fetchMock);
        const map = fakeMap();

        // The settings schema itself already enforces a minimum of 5 for
        // aircraft.pollSeconds, so this exercises the layer's own
        // independent floor with a value right at that boundary.
        mockSettings.set(SettingsSchema.parse({ aircraft: { enabled: true, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: false } }));
        const dispose = mountAircraftLayer(fakeLeaflet(), map, { reportCount: vi.fn(), reportAttribution: vi.fn() });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(4_999);
        expect(fetchMock).toHaveBeenCalledTimes(1); // not yet -- floor is 5s, not less

        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        dispose();
    });

    it('does not poll while disabled, and reports the aircraft count once enabled', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(oneAircraft)));
        const map = fakeMap();
        const reportCount = vi.fn();
        const reportAttribution = vi.fn();

        const dispose = mountAircraftLayer(fakeLeaflet(), map, { reportCount, reportAttribution });
        expect(reportCount).not.toHaveBeenCalled();

        mockSettings.set(SettingsSchema.parse({ aircraft: { enabled: true, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: false } }));
        await vi.advanceTimersByTimeAsync(0);

        expect(reportCount).toHaveBeenLastCalledWith(1, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith('Data: adsb.lol');

        dispose();
        expect(reportCount).toHaveBeenLastCalledWith(0, 0);
        expect(reportAttribution).toHaveBeenLastCalledWith(undefined);
    });

    it('hides on-ground aircraft when showOnGround is false, and shows them when true', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const onGroundResponse = {
            configured: true,
            fetchedAt: '2026-09-05T12:00:00Z',
            aircraft: [{ ...oneAircraft.aircraft[0], icao: 'ground01', altitudeFt: 'ground' }],
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(onGroundResponse)));
        const map = fakeMap();
        const reportCount = vi.fn();

        mockSettings.set(SettingsSchema.parse({ aircraft: { enabled: true, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: false } }));
        const dispose = mountAircraftLayer(fakeLeaflet(), map, { reportCount, reportAttribution: vi.fn() });
        await vi.advanceTimersByTimeAsync(0);
        expect(reportCount).toHaveBeenLastCalledWith(0, 0); // filtered out

        mockSettings.set(SettingsSchema.parse({ aircraft: { enabled: true, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: true } }));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reportCount).toHaveBeenLastCalledWith(1, 0); // now shown, distinctly styled

        dispose();
    });
});

describe('mountAircraftLayer -- name labels', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        mockSettings.set(SettingsSchema.parse({ aircraft: { enabled: false, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: false } }));
    });

    it('labels every aircraft with its callsign', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(oneAircraft)));
        const map = fakeMap();
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];

        mockSettings.set(SettingsSchema.parse({ aircraft: { enabled: true, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: false } }));
        const dispose = mountAircraftLayer(fakeLeaflet(createdPolygons), map, { reportCount: vi.fn(), reportAttribution: vi.fn() });
        await vi.advanceTimersByTimeAsync(0);

        // (visible, hitArea) pair -- the tooltip lives on the hit area.
        const [, hitArea] = createdPolygons;
        expect(hitArea?.tooltip?.textContent).toBe('TEST01');

        dispose();
    });

    it('falls back to the ICAO hex when the callsign is blank', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const blankCallsignResponse = {
            configured: true,
            fetchedAt: '2026-09-05T12:00:00Z',
            aircraft: [{ ...oneAircraft.aircraft[0], icao: 'noc4l1', callsign: '   ' }],
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(blankCallsignResponse)));
        const map = fakeMap();
        const createdPolygons: ReturnType<typeof fakePolygon>[] = [];

        mockSettings.set(SettingsSchema.parse({ aircraft: { enabled: true, pollSeconds: 5, maxAgeMinutes: 10, showOnGround: false } }));
        const dispose = mountAircraftLayer(fakeLeaflet(createdPolygons), map, { reportCount: vi.fn(), reportAttribution: vi.fn() });
        await vi.advanceTimersByTimeAsync(0);

        const [, hitArea] = createdPolygons;
        expect(hitArea?.tooltip?.textContent).toBe('noc4l1');

        dispose();
    });
});
