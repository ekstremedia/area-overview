import { describe, expect, it } from 'vitest';
import { createTrailStore } from './store.js';

interface Vessel {
    id: string;
    lat: number;
    lng: number;
    at: string;
    label?: string;
}

const SHAPE = {
    idOf: (vessel: Vessel): string => vessel.id,
    positionOf: (vessel: Vessel): { lat: number; lng: number; at: string } => ({ lat: vessel.lat, lng: vessel.lng, at: vessel.at }),
};

const OPTIONS = { maxPoints: 4, maxAgeMs: 60_000, forgetAfterMs: 300_000 };

function vessel(overrides: Partial<Vessel> = {}): Vessel {
    return { id: 'a', lat: 68.7, lng: 15.4, at: '2026-09-07T12:00:00.000Z', ...overrides };
}

const T0 = new Date('2026-09-07T12:00:00.000Z');

function at(secondsAfterT0: number): Date {
    return new Date(T0.getTime() + secondsAfterT0 * 1_000);
}

describe('createTrailStore', () => {
    it('remembers nothing to trail from a single sighting -- the current fix is the caller’s, not history', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel()], T0);

        expect(store.trailFor('a', T0)).toEqual([]);
        expect(store.size()).toBe(1);
    });

    it('offers earlier positions as a trail once a vessel moves, excluding where it is now', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel({ lat: 68.7, at: '2026-09-07T12:00:00.000Z' })], T0);
        store.record([vessel({ lat: 68.8, at: '2026-09-07T12:00:30.000Z' })], at(30));

        // Just the first fix: the second is where the vessel is reporting
        // from now, which the caller is already drawing as the vessel.
        expect(store.trailFor('a', at(30))).toEqual([{ lat: 68.7, lng: 15.4, at: '2026-09-07T12:00:00.000Z' }]);
    });

    it('ignores a restated fix, so a moored vessel never fills its own history with one spot', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel({ at: '2026-09-07T12:00:00.000Z' })], T0);
        store.record([vessel({ at: '2026-09-07T12:00:30.000Z' })], at(30)); // same coordinates
        store.record([vessel({ at: '2026-09-07T12:00:00.000Z', lat: 68.9 })], at(60)); // same timestamp

        expect(store.trailFor('a', at(60))).toEqual([]);
    });

    it('ages history out against wall-clock time, not the vessel’s own clock', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel({ lat: 68.7, at: '2026-09-07T12:00:00.000Z' })], T0);
        store.record([vessel({ lat: 68.8, at: '2026-09-07T12:00:30.000Z' })], at(30));
        expect(store.trailFor('a', at(30))).toHaveLength(1);

        // Two minutes on, with upstream restating the same stale fix: both
        // points are now beyond the 60s window. A cutoff taken from the
        // vessel's own timestamp would never have advanced.
        store.record([vessel({ lat: 68.8, at: '2026-09-07T12:00:30.000Z' })], at(150));

        expect(store.trailFor('a', at(150))).toEqual([]);
    });

    it('keeps only the newest maxPoints positions', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        for (let i = 0; i < 8; i++) {
            store.record([vessel({ lat: 68.7 + i / 100, at: new Date(T0.getTime() + i * 1_000).toISOString() })], at(i));
        }

        expect(store.trailFor('a', at(7))).toHaveLength(3); // 4 kept, minus the current one
    });

    it('forgets a vessel that stops appearing, so a box running for weeks stays bounded', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel()], T0);
        expect(store.size()).toBe(1);

        store.record([], at(400)); // past forgetAfterMs, and it was not in this poll

        expect(store.size()).toBe(0);
        expect(store.trailFor('a', at(400))).toEqual([]);
    });

    it('keeps a vessel that is merely missing from one poll', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel()], T0);
        store.record([], at(30)); // a blip in coverage, well inside the forget window

        expect(store.size()).toBe(1);
    });

    it('serves the last known vessels inside a bbox, for when an upstream is unreachable', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record(
            [vessel({ id: 'inside', lat: 68.7, lng: 15.4, label: 'here' }), vessel({ id: 'outside', lat: 60.0, lng: 5.0, label: 'far away' })],
            T0,
        );

        const inside = store.latestIn({ minLat: 68.0, minLng: 15.0, maxLat: 69.0, maxLng: 16.0 });

        expect(inside.map((v) => v.id)).toEqual(['inside']);
        // The whole record, not just coordinates: the route serves these
        // in place of an upstream response.
        expect(inside[0]?.label).toBe('here');
    });

    it('keeps a vessel with an unparseable timestamp servable, but contributes no history from it', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel({ at: 'not a date' })], T0);
        store.record([vessel({ at: 'still not a date', lat: 68.9 })], at(30));

        expect(store.trailFor('a', at(30))).toEqual([]);
        expect(store.latestIn({ minLat: 68, minLng: 15, maxLat: 69, maxLng: 16 })).toHaveLength(1);
    });

    it('never hands out points older than the window, even with no poll to age them', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel({ lat: 68.7, at: '2026-09-07T12:00:00.000Z' })], T0);
        store.record([vessel({ lat: 68.8, at: '2026-09-07T12:00:30.000Z' })], at(30));
        expect(store.trailFor('a', at(30))).toHaveLength(1);

        // A total outage: no poll lands, so nothing ages in the background.
        // The read itself must still refuse to serve expired positions --
        // this is exactly the state the routes' outage fallback reads in.
        expect(store.trailFor('a', at(600))).toEqual([]);
    });

    it('ages the history of a vessel that was absent from a poll, without forgetting the vessel', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel({ lat: 68.7, at: '2026-09-07T12:00:00.000Z' })], T0);
        store.record([vessel({ lat: 68.8, at: '2026-09-07T12:00:30.000Z' })], at(30));

        // Later polls simply do not include it -- clustered out of an
        // upstream's answer, or briefly out of coverage. Its points are
        // now beyond the window even though it was never re-recorded.
        store.record([], at(200));

        expect(store.trailFor('a', at(200))).toEqual([]);
        // ...but the vessel itself is still servable until the much longer
        // forget window, which is what the outage fallback depends on.
        expect(store.latestIn({ minLat: 68, minLng: 15, maxLat: 69, maxLng: 16 })).toHaveLength(1);
    });

    it('refuses a fix that is already older than the window, while still remembering the vessel', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel({ lat: 68.7, at: '2026-09-07T12:00:00.000Z' })], T0);
        // Upstream re-serves a position from well before the window. It is
        // a real vessel and must stay servable, but it contributes no
        // point -- least of all as the newest one, past where ageing looks.
        store.record([vessel({ lat: 68.8, at: '2026-09-07T11:00:00.000Z' })], at(30));

        expect(store.trailFor('a', at(30))).toEqual([]);
        expect(store.latestIn({ minLat: 68, minLng: 15, maxLat: 69, maxLng: 16 })).toHaveLength(1);
    });

    it('tracks each vessel separately', () => {
        const store = createTrailStore(SHAPE, OPTIONS);

        store.record([vessel({ id: 'a', lat: 68.7 }), vessel({ id: 'b', lat: 69.0 })], T0);
        store.record(
            [vessel({ id: 'a', lat: 68.8, at: '2026-09-07T12:00:30.000Z' }), vessel({ id: 'b', lat: 69.0, at: '2026-09-07T12:00:30.000Z' })],
            at(30),
        );

        expect(store.trailFor('a', at(30))).toHaveLength(1);
        expect(store.trailFor('b', at(30))).toEqual([]); // never moved
    });
});
