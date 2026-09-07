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
    latLngs: unknown[];
    tooltip: HTMLElement | undefined;
    setLatLngs: (next: unknown[]) => FakePolygon;
    setStyle: (style: Record<string, unknown>) => FakePolygon;
    bindPopup: () => FakePolygon;
    isPopupOpen: () => boolean;
    setPopupContent: () => FakePolygon;
    addTo: () => FakePolygon;
    bindTooltip: (content: HTMLElement, options?: Record<string, unknown>) => FakePolygon;
    unbindTooltip: () => FakePolygon;
    setTooltipContent: (content: HTMLElement) => FakePolygon;
}

function fakePolygon(latLngs: unknown[], initial: Record<string, unknown>): FakePolygon {
    const polygon: FakePolygon = {
        style: { ...initial },
        latLngs: [...latLngs],
        tooltip: undefined,
        setLatLngs: (next) => {
            polygon.latLngs = [...next];
            return polygon;
        },
        setStyle: (style) => {
            polygon.style = { ...polygon.style, ...style };
            return polygon;
        },
        bindPopup: () => polygon,
        isPopupOpen: () => false,
        setPopupContent: () => polygon,
        addTo: () => polygon,
        // Models the one real-Leaflet behaviour that broke production: a
        // `permanent` tooltip is opened the moment it is bound to an
        // on-map layer, and opening it resolves the anchor through
        // `Polygon.getCenter()` -> `polygonCenter()`, which throws this
        // exact message on a polygon with no points (Leaflet 1.9.4). The
        // fake used to accept any `bindTooltip` call, which is why a full
        // green test suite still shipped a map with no ships on it.
        bindTooltip: (content, options = {}) => {
            if (options.permanent === true && polygon.latLngs.length === 0) throw new Error('latlngs not passed');
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
        polygon: (latlngs: unknown[] = [], options: Record<string, unknown> = {}) => {
            const polygon = fakePolygon(latlngs, options);
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
        expect(hitArea?.tooltip?.textContent).toBe('ALPHA');
    });

    it('binds the label as an HTMLElement with textContent, never a raw string, so an API-derived label (e.g. an AIS ship name) can never be interpreted as HTML', () => {
        const created: FakePolygon[] = [];
        const labelFor = () => '<img src=x onerror=alert(1)>';
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions({ labelFor }));

        layer.update([glyph()], 30, new Date('2026-09-05T12:00:00Z'));

        const [, hitArea] = created;
        expect(hitArea?.tooltip).toBeInstanceOf(HTMLElement);
        expect(hitArea?.tooltip?.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(hitArea?.tooltip?.innerHTML).not.toContain('<img');
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
        expect(hitArea?.tooltip?.textContent).toBe('ALPHA');

        // ...loses its label when the status changes with no other field changing...
        layer.update([glyph({ data: { status: 1 } })], 30, now);
        expect(created).toHaveLength(2); // same entry reused, no new polygon pair
        expect(hitArea?.tooltip).toBeUndefined();

        // ...and regains it, with fresh content, once it goes back to status 0.
        layer.update([glyph({ data: { status: 0 } })], 30, now);
        expect(hitArea?.tooltip?.textContent).toBe('ALPHA');
    });

    it('gives both polygons their corners before binding the label, and finishes the update -- a labelled glyph must never be bound while empty', () => {
        const created: FakePolygon[] = [];
        const layer = createCanvasGlyphLayer(fakeLeaflet(created), fakeMap(), baseOptions({ labelFor: () => 'ALPHA' }));

        // Shipped broken once: `createEntry` built `L.polygon([])`, bound the
        // permanent tooltip, and only positioned the polygon afterwards --
        // so Leaflet threw `latlngs not passed` out of `bindTooltip`, out of
        // `update()`, and out of the effect driving it. Every later glyph in
        // the same batch was dropped, the count never reached the masthead
        // (a permanent `0 skip`), attribution never reached the footer, and
        // each poll orphaned another polygon pair on the map. Asserting the
        // count here is what proves `update()` ran to completion, not just
        // that the tooltip happens to be bound.
        layer.update([glyph({ data: { status: 0 } })], 30, new Date('2026-09-05T12:00:00Z'));

        const [visible, hitArea] = created;
        expect(visible?.latLngs).toHaveLength(3);
        expect(hitArea?.latLngs).toHaveLength(3);
        expect(hitArea?.tooltip?.textContent).toBe('ALPHA');
        expect(layer.count()).toBe(1);
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
