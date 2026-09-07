/**
 * `createTrailLayer`'s Leaflet-touching behaviour, with a fake `L`/
 * `Leaflet.Map` (same convention as `canvasGlyphLayer.test.ts`). The
 * history/fade maths underneath is covered by `trails.test.ts`; what
 * matters here is what actually gets added to and removed from the map.
 */
import { describe, expect, it } from 'vitest';
import type * as Leaflet from 'leaflet';
import { createTrailLayer } from './trailLayer.js';
import type { GlyphDescriptor } from './glyphs.js';

interface FakePolyline {
    latLngs: unknown;
    options: Record<string, unknown>;
    addTo: () => FakePolyline;
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

    it('tracks each glyph separately', () => {
        const created: FakePolyline[] = [];
        const live = new Set<FakePolyline>();
        const layer = createTrailLayer<null>(fakeLeaflet(created, live), fakeMap(), { color: 'cyan' });

        layer.update([glyph('a', 68.1, T0), glyph('b', 69.1, T0)], new Date(T0));
        layer.update([glyph('a', 68.2, T1), glyph('b', 69.2, T1)], new Date(T1));

        expect(live.size).toBe(2); // one segment each, not one shared trail
    });
});
