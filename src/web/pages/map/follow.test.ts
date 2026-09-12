/**
 * Following a vessel, against a fake `Leaflet.Map` (same convention as
 * the other map tests). What matters here is all about restraint and
 * about letting go: the map is moved by this module several times a
 * second, so it has to be able to tell its own movements from the
 * visitor's, and every one of the four ways out has to actually release
 * the slideshow again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { autoCycleHeld } from '../../shell/autoCycle.js';
import { followTarget, followVessel, isFollowing, stopFollowing, VESSEL_ZOOM, zoomToVessel } from './follow.js';

interface AppliedView {
    lat: number;
    lng: number;
    zoom: number;
    animate: boolean | undefined;
}

function fakeMap(initialZoom = 10): { map: Leaflet.Map; views: AppliedView[]; fire: (event: string) => void } {
    const handlers = new Map<string, Set<() => void>>();
    const views: AppliedView[] = [];
    let zoom = initialZoom;

    function fire(event: string): void {
        // Copied before iterating: a handler that stops the follow removes
        // itself mid-dispatch, exactly as Leaflet allows.
        for (const handler of [...(handlers.get(event) ?? [])]) handler();
    }

    const map = {
        getZoom: () => zoom,
        setView: (latLng: [number, number], nextZoom: number, options?: { animate?: boolean }) => {
            zoom = nextZoom;
            views.push({ lat: latLng[0], lng: latLng[1], zoom: nextZoom, animate: options?.animate });
            fire('movestart'); // Leaflet fires this synchronously, which is what the cancel guard hangs on
            return map;
        },
        on: (event: string, handler: () => void) => {
            const set = handlers.get(event) ?? new Set<() => void>();
            set.add(handler);
            handlers.set(event, set);
            return map;
        },
        off: (event: string, handler: () => void) => {
            handlers.get(event)?.delete(handler);
            return map;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Leaflet.Map;

    return { map, views, fire };
}

const NORDLYS = { id: '257123456', label: 'MS NORDLYS' };

afterEach(() => {
    stopFollowing();
    vi.useRealTimers();
});

describe('zoomToVessel', () => {
    it('centres on the vessel and zooms in to the vessel zoom', () => {
        const { map, views } = fakeMap(9);

        zoomToVessel(map, { lat: 68.7, lng: 15.4 });

        expect(views).toEqual([{ lat: 68.7, lng: 15.4, zoom: VESSEL_ZOOM, animate: undefined }]);
    });

    it('never zooms out from a closer view somebody already chose', () => {
        const { map, views } = fakeMap(17);

        zoomToVessel(map, { lat: 68.7, lng: 15.4 });

        expect(views[0]?.zoom).toBe(17);
    });

    it('does not start following, and does not hold the slideshow', () => {
        const { map } = fakeMap();

        zoomToVessel(map, { lat: 68.7, lng: 15.4 });

        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);
    });
});

describe('followVessel', () => {
    it('zooms to the vessel, names it, and holds the slideshow', () => {
        const { map, views } = fakeMap(9);

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));

        expect(views[0]).toEqual({ lat: 68.7, lng: 15.4, zoom: VESSEL_ZOOM, animate: false });
        expect(followTarget.get()).toEqual(NORDLYS);
        expect(isFollowing('257123456')).toBe(true);
        expect(isFollowing('someone else')).toBe(false);
        expect(autoCycleHeld.get()).toBe(true);
    });

    it('keeps the map under the vessel as it moves, without zooming again', () => {
        vi.useFakeTimers();
        const { map, views } = fakeMap();
        let lat = 68.7;

        followVessel(map, NORDLYS, () => ({ lat, lng: 15.4 }));
        const afterInitialZoom = views.length;

        lat = 68.75;
        vi.advanceTimersByTime(1_000);

        const latest = views[views.length - 1];
        expect(views.length).toBeGreaterThan(afterInitialZoom);
        expect(latest?.lat).toBe(68.75);
        expect(latest?.zoom).toBe(VESSEL_ZOOM); // held, not re-applied upward
    });

    it('does not mistake its own recentring for the visitor taking the wheel', () => {
        // The whole hazard of this feature: every recentre is a map move,
        // and Leaflet reports it exactly like a drag.
        vi.useFakeTimers();
        const { map } = fakeMap();
        let lat = 68.7;

        followVessel(map, NORDLYS, () => ({ lat, lng: 15.4 }));
        for (let frame = 0; frame < 20; frame++) {
            lat += 0.001;
            vi.advanceTimersByTime(200);
        }

        expect(followTarget.get()).toEqual(NORDLYS);
    });

    it('lets go the moment the visitor pans or zooms, and gives the slideshow back', () => {
        vi.useFakeTimers();
        const { map, fire } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        expect(autoCycleHeld.get()).toBe(true);

        fire('movestart'); // a drag, a wheel, a zoom button, the reset control, an idle reset

        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);
    });

    it('stops moving the map once it has let go', () => {
        vi.useFakeTimers();
        const { map, views, fire } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        fire('movestart');
        const afterStop = views.length;

        vi.advanceTimersByTime(5_000);
        expect(views).toHaveLength(afterStop);
    });

    it('holds station through a vessel missing from a poll or two', () => {
        // A ship absent from one answer has not gone anywhere, and an
        // aircraft blinking out is the normal state of ADS-B here.
        vi.useFakeTimers();
        const { map } = fakeMap();
        let reported: { lat: number; lng: number } | undefined = { lat: 68.7, lng: 15.4 };

        followVessel(map, NORDLYS, () => reported);
        reported = undefined;
        vi.advanceTimersByTime(25_000);

        expect(followTarget.get()).toEqual(NORDLYS);
    });

    it('gives up on a vessel that has genuinely gone, rather than holding over empty water', () => {
        vi.useFakeTimers();
        const { map } = fakeMap();
        let reported: { lat: number; lng: number } | undefined = { lat: 68.7, lng: 15.4 };

        followVessel(map, NORDLYS, () => reported);
        reported = undefined;
        vi.advanceTimersByTime(31_000);

        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);
    });

    it('following a second vessel drops the first, holding the slideshow exactly once', () => {
        vi.useFakeTimers();
        const { map } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        followVessel(map, { id: '4787aa', label: 'WIF607' }, () => ({ lat: 69.0, lng: 16.0 }));

        expect(followTarget.get()?.id).toBe('4787aa');
        expect(autoCycleHeld.get()).toBe(true);

        stopFollowing();
        expect(autoCycleHeld.get()).toBe(false); // the first follow's hold did not outlive it
    });

    it('stopping twice is safe, and stopping nothing at all is too', () => {
        const { map } = fakeMap();

        stopFollowing();
        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        stopFollowing();
        stopFollowing();

        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);
    });

    it('follows a vessel it cannot place yet without moving the map', () => {
        const { map, views } = fakeMap();

        followVessel(map, NORDLYS, () => undefined);

        expect(views).toHaveLength(0);
        expect(followTarget.get()).toEqual(NORDLYS);
    });
});
