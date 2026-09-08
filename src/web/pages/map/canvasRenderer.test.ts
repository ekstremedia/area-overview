/**
 * One canvas per map, and every path layer in it.
 *
 * The bug this exists to prevent was invisible in every other test: each
 * layer worked perfectly on its own, and together they produced a map
 * where the ships could not be tapped at all, because the trail layer's
 * own full-size `<canvas>` sat on top of the glyph layer's and took every
 * click. Nothing about a single layer's behaviour catches that -- only
 * the fact that the two share a renderer does.
 */
import { describe, expect, it } from 'vitest';
import type * as Leaflet from 'leaflet';
import { sharedCanvasRenderer } from './canvasRenderer.js';
import { createCanvasGlyphLayer } from './canvasGlyphLayer.js';
import { createTrailLayer } from './trailLayer.js';
import type { GlyphDescriptor } from './glyphs.js';

interface TestData {
    name: string;
}

interface CreatedPath {
    options: Record<string, unknown>;
}

/** A fake `L` covering the calls both layers make, counting every renderer it is asked for. */
function fakeLeaflet(created: CreatedPath[], canvasCalls: { count: number }): typeof Leaflet {
    const group = { addTo: () => group, addLayer: () => group, removeLayer: () => group };
    function path(options: Record<string, unknown>): Record<string, unknown> {
        const self: Record<string, unknown> = {
            options,
            addTo: () => self,
            setLatLngs: () => self,
            setStyle: () => self,
            bindPopup: () => self,
            isPopupOpen: () => false,
            setPopupContent: () => self,
            bindTooltip: () => self,
            unbindTooltip: () => self,
            setTooltipContent: () => self,
            getTooltip: () => undefined,
        };
        created.push({ options });
        return self;
    }
    return {
        canvas: () => {
            canvasCalls.count += 1;
            return { id: canvasCalls.count };
        },
        layerGroup: () => group,
        polygon: (_latLngs: unknown, options: Record<string, unknown> = {}) => path(options),
        polyline: (_latLngs: unknown, options: Record<string, unknown> = {}) => path(options),
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

function glyph(overrides: Partial<GlyphDescriptor<TestData>> = {}): GlyphDescriptor<TestData> {
    return { id: 'a', lat: 68.7, lng: 15.4, heading: 0, timestamp: '2026-09-05T12:00:00Z', data: { name: 'Storoey' }, ...overrides };
}

describe('sharedCanvasRenderer', () => {
    it('hands the same renderer to every caller for one map', () => {
        const L = fakeLeaflet([], { count: 0 });
        const map = fakeMap();

        expect(sharedCanvasRenderer(L, map)).toBe(sharedCanvasRenderer(L, map));
    });

    it('gives a different map its own', () => {
        // A remounted map page is a new Leaflet instance; it must not draw
        // into the dead one's canvas.
        const L = fakeLeaflet([], { count: 0 });

        expect(sharedCanvasRenderer(L, fakeMap())).not.toBe(sharedCanvasRenderer(L, fakeMap()));
    });
});

describe("the map's path layers", () => {
    it("draw into a single canvas, so neither layer can cover the other's tap targets", () => {
        const created: CreatedPath[] = [];
        const canvasCalls = { count: 0 };
        const L = fakeLeaflet(created, canvasCalls);
        const map = fakeMap();

        const glyphs = createCanvasGlyphLayer<TestData>(L, map, {
            color: '#62c5ee',
            widthPx: 14,
            heightPx: 19,
            hitRadiusPx: 22,
            buildPopup: () => document.createElement('div'),
        });
        const trails = createTrailLayer<TestData>(L, map, { color: '#62c5ee' });

        glyphs.update([glyph()], 30, new Date('2026-09-05T12:00:00Z'));
        trails.update([glyph()], new Date('2026-09-05T12:00:00Z'));
        trails.update([glyph({ lat: 68.8 })], new Date('2026-09-05T12:00:30Z'));

        expect(canvasCalls.count).toBe(1);
        const renderers = new Set(created.map((path) => path.options.renderer));
        expect(created.length).toBeGreaterThan(1); // glyph, hit area, and at least one trail segment
        expect(renderers.size).toBe(1);
    });
});
