/**
 * `createCanvasGlyphLayer`'s Leaflet-touching behaviour, exercised with a
 * fake `L`/`Leaflet.Map` (same convention as `ships.test.ts`/
 * `aircraft.test.ts`'s `fakeMap`) rather than a real Leaflet canvas -- the
 * pure diff/opacity/geometry logic underneath is already covered by
 * `glyphs.test.ts`. Focused here on the one thing that has no other
 * coverage: `colorFor`'s per-glyph colour override, at creation and on a
 * later `update()` call.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { createCanvasGlyphLayer, type CanvasGlyphLayerOptions } from './canvasGlyphLayer.js';
import type { GlyphDescriptor } from './glyphs.js';

interface FakePolygon {
    style: Record<string, unknown>;
    tooltip: string | undefined;
    setLatLngs: () => FakePolygon;
    setStyle: (style: Record<string, unknown>) => FakePolygon;
    bindPopup: () => FakePolygon;
    isPopupOpen: () => boolean;
    setPopupContent: () => FakePolygon;
    addTo: () => FakePolygon;
    bindTooltip: (content: string) => FakePolygon;
    unbindTooltip: () => FakePolygon;
    setTooltipContent: (content: string) => FakePolygon;
}

function fakePolygon(initial: Record<string, unknown>): FakePolygon {
    const polygon: FakePolygon = {
        style: { ...initial },
        tooltip: undefined,
        setLatLngs: () => polygon,
        setStyle: (style) => {
            polygon.style = { ...polygon.style, ...style };
            return polygon;
        },
        bindPopup: () => polygon,
        isPopupOpen: () => false,
        setPopupContent: () => polygon,
        addTo: () => polygon,
        bindTooltip: (content) => {
            polygon.tooltip = content;
            return polygon;
        },
        unbindTooltip: () => {
            polygon.tooltip = undefined;
            return polygon;
        },
        setTooltipContent: (content) => {
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

function fakeLeaflet(createdPolygons: FakePolygon[]): typeof Leaflet {
    return {
        canvas: () => ({}),
        layerGroup: fakeLayerGroup,
        polygon: (_latlngs: unknown, options: Record<string, unknown> = {}) => {
            const polygon = fakePolygon(options);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Leaflet.Map;
}

interface TestData {
    status: number;
}

function glyph(overrides: Partial<GlyphDescriptor<TestData>> = {}): GlyphDescriptor<TestData> {
    return { id: 'a', lat: 68.7, lng: 15.4, heading: 0, timestamp: '2026-09-05T12:00:00Z', data: { status: 1 }, ...overrides };
}

function baseOptions(overrides: Partial<CanvasGlyphLayerOptions<TestData>> = {}): CanvasGlyphLayerOptions<TestData> {
    return {
        color: 'blue',
        widthPx: 10,
        heightPx: 10,
        hitRadiusPx: 22,
        buildPopup: () => document.createElement('div'),
        ...overrides,
    };
}

describe('createCanvasGlyphLayer colorFor', () => {
    it('uses the flat `color` at creation when colorFor is absent (aircraft path unaffected)', () => {
        const created: FakePolygon[] = [];
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions());

        layer.update([glyph()], 30, new Date('2026-09-05T12:00:00Z'));

        const [visible] = created;
        expect(visible?.style.color).toBe('blue');
        expect(visible?.style.fillColor).toBe('blue');
    });

    it('colorFor overrides the flat color per-glyph at creation', () => {
        const created: FakePolygon[] = [];
        const colorFor = vi.fn((data: TestData) => (data.status === 0 ? 'green' : 'blue'));
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions({ colorFor }));

        layer.update([glyph({ data: { status: 0 } })], 30, new Date('2026-09-05T12:00:00Z'));

        const [visible] = created;
        expect(visible?.style.color).toBe('green');
        expect(visible?.style.fillColor).toBe('green');
    });

    it('re-applies colorFor on a later update() call, even when lat/lng/heading/timestamp are unchanged', () => {
        const created: FakePolygon[] = [];
        const colorFor = (data: TestData) => (data.status === 0 ? 'green' : 'blue');
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions({ colorFor }));
        const now = new Date('2026-09-05T12:00:00Z');

        layer.update([glyph({ data: { status: 1 } })], 30, now);
        const [visible] = created;
        expect(visible?.style.color).toBe('blue');

        // Same id/lat/lng/heading/timestamp -- glyphs.ts's own diffing would
        // not flag this as a "toUpdate", but the per-poll refresh loop must
        // still recompute colour from the fresh `data`, not just opacity.
        layer.update([glyph({ data: { status: 0 } })], 30, now);
        expect(created).toHaveLength(2); // no new polygon created, same entry (visible + hit area) reused
        expect(visible?.style.color).toBe('green');
        expect(visible?.style.fillColor).toBe('green');
    });

    it('never creates a second polygon set for the same id across updates', () => {
        const created: FakePolygon[] = [];
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions());
        const now = new Date('2026-09-05T12:00:00Z');

        layer.update([glyph()], 30, now);
        layer.update([glyph()], 30, now);

        // Two polygons per glyph (visible + hit area), never duplicated.
        expect(created).toHaveLength(2);
    });
});

describe('createCanvasGlyphLayer labelFor', () => {
    it('binds no tooltip when labelFor is absent', () => {
        const created: FakePolygon[] = [];
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions());

        layer.update([glyph()], 30, new Date('2026-09-05T12:00:00Z'));

        const [, hitArea] = created;
        expect(hitArea?.tooltip).toBeUndefined();
    });

    it('binds a tooltip on the hit area at creation when labelFor returns text', () => {
        const created: FakePolygon[] = [];
        const labelFor = (data: TestData) => (data.status === 0 ? 'ALPHA' : null);
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions({ labelFor }));

        layer.update([glyph({ data: { status: 0 } })], 30, new Date('2026-09-05T12:00:00Z'));

        const [, hitArea] = created;
        expect(hitArea?.tooltip).toBe('ALPHA');
    });

    it('binds no tooltip at creation when labelFor returns null', () => {
        const created: FakePolygon[] = [];
        const labelFor = (data: TestData) => (data.status === 0 ? 'ALPHA' : null);
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions({ labelFor }));

        layer.update([glyph({ data: { status: 1 } })], 30, new Date('2026-09-05T12:00:00Z'));

        const [, hitArea] = created;
        expect(hitArea?.tooltip).toBeUndefined();
    });

    it('re-evaluates labelFor on a later update() call, even when lat/lng/heading/timestamp are unchanged', () => {
        const created: FakePolygon[] = [];
        const labelFor = (data: TestData) => (data.status === 0 ? 'ALPHA' : null);
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions({ labelFor }));
        const now = new Date('2026-09-05T12:00:00Z');

        // Starts labelled...
        layer.update([glyph({ data: { status: 0 } })], 30, now);
        const [, hitArea] = created;
        expect(hitArea?.tooltip).toBe('ALPHA');

        // ...loses its label when the status changes with no other field changing...
        layer.update([glyph({ data: { status: 1 } })], 30, now);
        expect(created).toHaveLength(2); // same entry reused, no new polygon pair
        expect(hitArea?.tooltip).toBeUndefined();

        // ...and regains it, with fresh content, once it goes back to status 0.
        layer.update([glyph({ data: { status: 0 } })], 30, now);
        expect(hitArea?.tooltip).toBe('ALPHA');
    });

    it('treats an empty-string label the same as null -- no tooltip bound', () => {
        const created: FakePolygon[] = [];
        const labelFor = () => '';
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions({ labelFor }));

        layer.update([glyph()], 30, new Date('2026-09-05T12:00:00Z'));

        const [, hitArea] = created;
        expect(hitArea?.tooltip).toBeUndefined();
    });
});
