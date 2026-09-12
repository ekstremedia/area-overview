/**
 * `createTrailLayer`'s Leaflet-touching behaviour, with a fake `L`/
 * `Leaflet.Map` (same convention as `canvasGlyphLayer.test.ts`). The
 * history/fade maths underneath is covered by `trails.test.ts`; what
 * matters here is what actually gets added to and removed from the map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { createTrailLayer } from './trailLayer.js';
import type { GlyphDescriptor } from './glyphs.js';

interface FakePolyline {
    latLngs: unknown;
    options: Record<string, unknown>;
    addTo: () => FakePolyline;
    setLatLngs: (latLngs: unknown) => FakePolyline;
    setStyle: (style: Record<string, unknown>) => FakePolyline;
}

function fakeLeaflet(created: FakePolyline[], live: Set<FakePolyline>): typeof Leaflet {
    const group = {
        addTo: () => group,
        addLayer: () => group,
        removeLayer: (layer: FakePolyline) => {
            live.delete(layer);
            return group;
        },
    };
    return {
        canvas: () => ({}),
        layerGroup: () => group,
        polyline: (latLngs: unknown, options: Record<string, unknown> = {}) => {
            const line: FakePolyline = {
                latLngs,
                options,
                addTo: () => {
                    live.add(line);
                    return line;
                },
                setLatLngs: (next: unknown) => {
                    line.latLngs = next;
                    return line;
                },
                setStyle: (style: Record<string, unknown>) => {
                    Object.assign(line.options, style);
                    return line;
                },
            };
            created.push(line);
            return line;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as typeof Leaflet;
}

function fakeMap(): Leaflet.Map {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { removeLayer: () => undefined } as any as Leaflet.Map;
}

function glyph(id: string, lat: number, timestamp: string): GlyphDescriptor<null> {
    return { id, lat, lng: 15.4, heading: 0, timestamp, data: null };
}

const T0 = '2026-09-07T12:00:00Z';
const T1 = '2026-09-07T12:00:15Z';
const T2 = '2026-09-07T12:00:30Z';

/** 60 knots due north is a nautical mile a minute, so any elapsed time projects to a latitude that is easy to reason about. */
const northbound = (): { speedKt: number; courseDeg: number } => ({ speedKt: 60, courseDeg: 0 });

/** The far end of a segment -- the projected position, for the head; the newer fix, for a history leg. */
function endOf(line: FakePolyline | undefined): [number, number] | undefined {
    return (line?.latLngs as [number, number][] | undefined)?.[1];
}

function startOf(line: FakePolyline | undefined): [number, number] | undefined {
    return (line?.latLngs as [number, number][] | undefined)?.[0];
}

afterEach(() => {
    vi.useRealTimers();
});

describe('createTrailLayer', () => {
    it('draws nothing from a single sighting -- a trail needs somewhere to have come from', () => {
        const created: FakePolyline[] = [];
        const layer = createTrailLayer<null>(fakeLeaflet(created, new Set()), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0)], new Date(T0));

        expect(created).toHaveLength(0);
    });

    it('draws a fading segment per leg once a glyph has moved', () => {
        const created: FakePolyline[] = [];
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet(created, live), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0)], new Date(T0));
        layer.update([glyph('a', 68.2, T1)], new Date(T1));
        expect(live.size).toBe(1);

        layer.update([glyph('a', 68.3, T2)], new Date(T2));
        expect(live.size).toBe(2);

        // Older leg fainter than the newer one: the fade is the whole point.
        const [older, newer] = [...live];
        expect(Number(older?.options.opacity)).toBeLessThan(Number(newer?.options.opacity));
        // Scenery only -- a trail must never intercept a tap meant for the
        // glyph's own hit target.
        expect(newer?.options.interactive).toBe(false);
        expect(newer?.options.color).toBe('cyan');
    });

    it('redraws nothing for a glyph that reported the same position again', () => {
        const created: FakePolyline[] = [];
        const layer = createTrailLayer<null>(fakeLeaflet(created, new Set()), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0)], new Date(T0));
        layer.update([glyph('a', 68.2, T1)], new Date(T1));
        const afterMove = created.length;

        // A moored ship, restating its position on the next two polls.
        layer.update([glyph('a', 68.2, T2)], new Date(T2));
        layer.update([glyph('a', 68.2, T2)], new Date(T2));

        expect(created).toHaveLength(afterMove); // no churn of throwaway polylines
    });

    it('keeps a trail for a glyph missing from one update -- a ship absorbed into a cluster has not gone anywhere', () => {
        const created: FakePolyline[] = [];
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet(created, live), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0)], new Date(T0));
        layer.update([glyph('a', 68.2, T1)], new Date(T1));
        expect(live.size).toBe(1);

        layer.update([], new Date(T2)); // clustered away, or simply not in this poll

        expect(live.size).toBe(1); // still drawn, and its history still standing
    });

    it('forgets a glyph gone long enough, removing its segments from the map', () => {
        const created: FakePolyline[] = [];
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet(created, live), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0)], new Date(T0));
        layer.update([glyph('a', 68.2, T1)], new Date(T1));
        expect(live.size).toBe(1);

        // Well past the forget-after window: nothing of it may remain on the
        // map, on a display that runs for weeks.
        layer.update([], new Date('2026-09-07T13:00:00Z'));

        expect(live.size).toBe(0);
    });

    it('ignores a fix with an unparseable timestamp instead of poisoning the history with NaN', () => {
        const created: FakePolyline[] = [];
        const layer = createTrailLayer<null>(fakeLeaflet(created, new Set()), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, 'not a date')], new Date(T0));
        layer.update([glyph('a', 68.2, 'also not a date')], new Date(T1));

        expect(created).toHaveLength(0);
    });

    it('clear() erases every trail and its history, unlike an empty update', () => {
        const created: FakePolyline[] = [];
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet(created, live), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0)], new Date(T0));
        layer.update([glyph('a', 68.2, T1)], new Date(T1));
        expect(live.size).toBe(1);

        layer.clear(); // the upstream reported itself unconfigured
        expect(live.size).toBe(0);

        // History is gone too: the next sighting starts a fresh trail with
        // nothing to draw yet, rather than resuming the old one.
        layer.update([glyph('a', 68.3, T2)], new Date(T2));
        expect(live.size).toBe(0);
    });

    it('draws no leading segment without a velocity to dead-reckon from', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T1)); // well after the fix: there would be plenty to project, given a speed
        const created: FakePolyline[] = [];
        const layer = createTrailLayer<null>(fakeLeaflet(created, new Set()), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0)], new Date(T1));
        vi.advanceTimersByTime(5_000);

        expect(created).toHaveLength(0);
        layer.dispose();
    });

    it('tracks each glyph separately', () => {
        const created: FakePolyline[] = [];
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet(created, live), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0), glyph('b', 69.1, T0)], new Date(T0));
        layer.update([glyph('a', 68.2, T1), glyph('b', 69.2, T1)], new Date(T1));

        expect(live.size).toBe(2); // one segment each, not one shared trail
    });
});

/**
 * The bug these cover: the glyph dead-reckons forward between polls while
 * the history only grows when a fix lands, so the tail stayed nailed to
 * the last fix and the glyph sailed out ahead of it -- a gap that reopened
 * after every poll and was widest for the fastest things on the map.
 */
describe('createTrailLayer, given a velocity', () => {
    it('runs a leading segment from the last fix to where the glyph has glided to', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T1)); // 15s past the fix: 0.25nm at 60kt
        const created: FakePolyline[] = [];
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet(created, live), fakeMap(), { color: 'cyan', velocityFor: northbound });

        layer.update([glyph('a', 68.1, T0)], new Date(T1));

        // A tail from a single sighting, which the reported positions alone
        // could never draw: the glyph is already ahead of its own fix.
        expect(live.size).toBe(1);
        const [head] = [...live];
        expect(startOf(head)).toEqual([68.1, 15.4]);
        expect(endOf(head)?.[0]).toBeCloseTo(68.1 + 0.25 / 60, 4);
        expect(head?.options.interactive).toBe(false);

        layer.dispose();
    });

    it('moves that segment on its own timer rather than rebuilding it every frame', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T0));
        const created: FakePolyline[] = [];
        const layer = createTrailLayer<null>(fakeLeaflet(created, new Set()), fakeMap(), { color: 'cyan', velocityFor: northbound });

        layer.update([glyph('a', 68.1, T0)], new Date(T0));
        expect(created).toHaveLength(0); // the fix is this instant old: nothing to project onto yet

        vi.advanceTimersByTime(1_000);
        expect(created).toHaveLength(1);
        const reachedAfterOneSecond = endOf(created[0])?.[0] ?? 0;

        vi.advanceTimersByTime(4_000);
        expect(created).toHaveLength(1); // one polyline, moved -- not five thrown away
        expect(endOf(created[0])?.[0]).toBeGreaterThan(reachedAfterOneSecond);

        layer.dispose();
    });

    it('re-anchors the leading segment to each new fix as it lands', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T1));
        const created: FakePolyline[] = [];
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet(created, live), fakeMap(), { color: 'cyan', velocityFor: northbound });

        layer.update([glyph('a', 68.1, T0)], new Date(T1));
        vi.setSystemTime(new Date(T2));
        layer.update([glyph('a', 68.2, T1)], new Date(T2));

        // The history leg T0->T1, and the head hanging off its newer end
        // rather than off the position it started from.
        expect(live.size).toBe(2);
        const head = [...live].find((line) => startOf(line)?.[0] === 68.2);
        expect(head).toBeDefined();
        expect(endOf(head)?.[0]).toBeGreaterThan(68.2);

        layer.dispose();
    });

    it('gives a stationary vessel no leading segment -- there is nowhere for it to have got to', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T1));
        const created: FakePolyline[] = [];
        const layer = createTrailLayer<null>(fakeLeaflet(created, new Set()), fakeMap(), {
            color: 'cyan',
            velocityFor: () => ({ speedKt: 0, courseDeg: 0 }),
        });

        layer.update([glyph('a', 68.1, T0)], new Date(T1));
        vi.advanceTimersByTime(5_000);

        expect(created).toHaveLength(0);
        layer.dispose();
    });

    it('takes the leading segment off the map with the rest of the trail', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T1));
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet([], live), fakeMap(), { color: 'cyan', velocityFor: northbound });

        layer.update([glyph('a', 68.1, T0)], new Date(T1));
        expect(live.size).toBe(1);

        layer.clear();
        expect(live.size).toBe(0);

        layer.dispose();
    });
});
