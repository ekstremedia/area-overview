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
import { advanceFollow, followTarget, followVessel, isFollowing, stopFollowing, VESSEL_ZOOM, zoomToVessel } from './follow.js';

interface AppliedView {
    lat: number;
    lng: number;
    zoom: number;
    animate: boolean | undefined;
}

function fakeMap(initialZoom = 10): { map: Leaflet.Map; views: AppliedView[]; fire: (event: string) => void; container: HTMLElement } {
    const handlers = new Map<string, Set<() => void>>();
    const views: AppliedView[] = [];
    let zoom = initialZoom;

    function fire(event: string): void {
        // Copied before iterating: a handler that stops the follow removes
        // itself mid-dispatch, exactly as Leaflet allows.
        for (const handler of [...(handlers.get(event) ?? [])]) handler();
    }

    const container = document.createElement('div');
    const map = {
        getContainer: () => container,
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

    return { map, views, fire, container };
}

const NORDLYS = { id: '257123456', label: 'MS NORDLYS', layer: 'ships' } as const;

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

    it('keeps the map under the vessel as its layer redraws it, without zooming again', () => {
        const { map, views } = fakeMap();
        let lat = 68.7;

        followVessel(map, NORDLYS, () => ({ lat, lng: 15.4 }));
        const afterInitialZoom = views.length;

        lat = 68.75;
        advanceFollow(); // what a glyph layer calls at the end of its motion frame

        const latest = views[views.length - 1];
        expect(views.length).toBeGreaterThan(afterInitialZoom);
        expect(latest?.lat).toBe(68.75);
        expect(latest?.zoom).toBe(VESSEL_ZOOM); // held, not re-applied upward
        expect(latest?.animate).toBe(false);
    });

    it('does not mistake its own recentring for the visitor taking the wheel', () => {
        // The whole hazard of this feature: every recentre is a map move,
        // and Leaflet reports it exactly like a drag.
        const { map } = fakeMap();
        let lat = 68.7;

        followVessel(map, NORDLYS, () => ({ lat, lng: 15.4 }));
        for (let frame = 0; frame < 20; frame++) {
            lat += 0.001;
            advanceFollow();
        }

        expect(followTarget.get()).toEqual(NORDLYS);
    });

    it('lets go on a map move the visitor actually caused, and gives the slideshow back', () => {
        const { map, container, fire } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        expect(autoCycleHeld.get()).toBe(true);

        container.dispatchEvent(new Event('pointerdown')); // a drag, a tap on a zoom button
        fire('movestart');

        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);
    });

    it('stands off while the visitor is touching the map, so their zoom can actually land', () => {
        // At the follow frame rate, recentring would otherwise interrupt
        // Leaflet's own zoom animation before it took effect -- the zoom
        // was silently undone, and the `movestart` that should have ended
        // the follow never arrived, so the map could not be zoomed at all
        // while following.
        const { map, views, container } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        const afterStart = views.length;

        container.dispatchEvent(new Event('pointerdown'));
        advanceFollow();

        expect(views).toHaveLength(afterStart); // the map was left alone
    });

    it("treats a slow drag as the visitor's, however long the pointer was held first", () => {
        // Press, hold, then drag: the move arrived outside the gesture
        // window, so the follow neither yielded to the drag nor ended, and
        // the map could not be taken back at all.
        vi.useFakeTimers();
        const { map, container, fire } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        container.dispatchEvent(new Event('pointerdown'));
        vi.advanceTimersByTime(5_000); // held still, well past GESTURE_WINDOW_MS

        // Now it actually moves. happy-dom has no PointerEvent buttons, so
        // a plain move event stands in for the drag the browser sends.
        container.dispatchEvent(new Event('pointermove'));
        fire('movestart');

        expect(followTarget.get()).toBeNull();
    });

    it('gives up as soon as its layer stops being able to place the vessel', () => {
        // The layer holds the last fix for its own `LOSE_AFTER_MS` before
        // it stops answering; waiting out a second full window here would
        // hold the map, and the slideshow, for twice as long as documented.
        vi.useFakeTimers();
        const { map } = fakeMap();
        let reported: { lat: number; lng: number } | undefined = { lat: 68.7, lng: 15.4 };

        followVessel(map, NORDLYS, () => reported);
        vi.advanceTimersByTime(2_000); // placed at least once
        reported = undefined;
        vi.advanceTimersByTime(1_500);

        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);
    });

    it('holds on through a map move nobody asked for', () => {
        // Leaflet re-measuring its container after a tab comes back, a
        // catch-up poll, a stray `setView` from elsewhere in the app. The
        // first version cancelled on any of these, which read as the
        // follow dropping out at random.
        const { map, fire } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        fire('movestart');

        expect(followTarget.get()).toEqual(NORDLYS);
    });

    it('holds on while the tab is away, and through the mouse merely moving over the map', () => {
        vi.useFakeTimers();
        const { map, container } = fakeMap();
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        vi.advanceTimersByTime(5 * 60_000);
        hidden.mockReturnValue(false);

        container.dispatchEvent(new Event('mousemove'));
        container.dispatchEvent(new Event('mouseover'));

        expect(followTarget.get()).toEqual(NORDLYS);
        hidden.mockRestore();
    });

    it('yields to the idle reset putting the home view back', () => {
        // Both want the map, and the display returning itself to neutral
        // wins -- otherwise the two fight for the view every frame.
        const { map } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        window.dispatchEvent(new CustomEvent('area-overview:idle-reset'));

        expect(followTarget.get()).toBeNull();
        expect(autoCycleHeld.get()).toBe(false);
    });

    it('stops moving the map once it has let go', () => {
        const { map, views, container, fire } = fakeMap();

        followVessel(map, NORDLYS, () => ({ lat: 68.7, lng: 15.4 }));
        container.dispatchEvent(new Event('pointerdown'));
        fire('movestart');
        const afterStop = views.length;

        advanceFollow();
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

    it("does not charge a hidden display's time to the missing-vessel clock", () => {
        // A kiosk whose tab was hidden for an hour polls nothing and draws
        // nothing, so a vessel cannot meaningfully be "missing" over that
        // hour -- measured against a wall clock it would come back and drop
        // the follow on its very first frame.
        vi.useFakeTimers();
        const { map } = fakeMap();
        let reported: { lat: number; lng: number } | undefined = { lat: 68.7, lng: 15.4 };
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

        followVessel(map, NORDLYS, () => reported);
        reported = undefined;
        vi.advanceTimersByTime(60 * 60_000); // an hour asleep

        hidden.mockReturnValue(false);
        vi.advanceTimersByTime(1_000); // and back
        expect(followTarget.get()).toEqual(NORDLYS);

        // The clock starts from the moment it is being looked at again.
        vi.advanceTimersByTime(31_000);
        expect(followTarget.get()).toBeNull();
        hidden.mockRestore();
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
        followVessel(map, { id: '4787aa', label: 'WIF607', layer: 'aircraft' }, () => ({ lat: 69.0, lng: 16.0 }));

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
