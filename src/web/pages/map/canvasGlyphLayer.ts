/**
 * The Leaflet-touching half of the canvas glyph rendering approach: every
 * ship/aircraft is an `L.Polygon` (a rotated triangle is just a 3-point
 * polygon) rendered through one shared `L.Canvas` renderer per layer --
 * so a busy day with hundreds of ships/aircraft is still one `<canvas>`
 * element per layer, never one DOM node per glyph.
 *
 * This is a deliberate compromise/choice among the options the phase
 * considered: rather than hand-rolling a raw `<canvas>` overlay with
 * manual hit-testing and manual `stopPropagation` bookkeeping against the
 * map's own click handling (needed so a glyph tap doesn't *also* trigger
 * `MapPage.ts`'s tap-to-forecast handler), this reuses Leaflet's own
 * `L.Canvas` renderer and its already-correct, already-tested path
 * click/hit-test/`stopPropagation` behaviour -- the exact same mechanism
 * `markers.ts`'s `L.Marker`s already rely on (see `MapPage.ts`'s doc
 * comment: "Leaflet doesn't fire the map's own 'click' for a marker click
 * that opens a popup"). The cost is that `L.Polygon` vertices are
 * geographic (`LatLng`), not fixed-pixel, so keeping a constant on-screen
 * glyph size across zoom levels means recomputing each glyph's three
 * corners via `map.project`/`unproject` -- on every data update, and once
 * more on every `zoomend` (panning needs no recompute at all: Leaflet's
 * canvas renderer already repaints `LatLng`-based paths correctly as the
 * map pans, for free).
 *
 * Each glyph is actually two overlapping polygons sharing one renderer:
 * a small, non-interactive, visibly-coloured triangle (the glyph itself)
 * and a larger, invisible, interactive one underneath sized for a 44px
 * tap target (`hitRadiusPx`) -- `bindPopup` lives on the invisible one.
 * Both are updated in place (`setLatLngs`/`setStyle`) across polls, never
 * recreated, so an open popup survives a data refresh untouched.
 */
import type * as Leaflet from 'leaflet';
import { diffGlyphs, rotatedTrianglePoints, visibleGlyphs, type GlyphDescriptor } from './glyphs.js';

export interface CanvasGlyphLayerOptions<T> {
    /** A literal colour string -- see `liveLayerColors.ts`'s doc comment for why this can't be a CSS custom property. */
    color: string;
    widthPx: number;
    heightPx: number;
    /** Half-width, in px, of the invisible hit-target triangle -- >= 22 gives a >= 44px tap diameter. */
    hitRadiusPx: number;
    buildPopup: (data: T) => HTMLElement;
    /** True for a glyph that should render distinctly/dimmed (e.g. an aircraft reporting from the ground). Defaults to never-distinct. */
    isDistinct?: (data: T) => boolean;
}

export interface CanvasGlyphLayer<T> {
    /** Applies the latest full item list -- ages/filters, diffs by id, and updates polygons in place. */
    update(items: readonly GlyphDescriptor<T>[], maxAgeMinutes: number, now: Date): void;
    /** Count of glyphs currently rendered (post age-filter) -- for the masthead's live-layer counts. */
    count(): number;
    dispose(): void;
}

interface GlyphEntry {
    visible: Leaflet.Polygon;
    hitArea: Leaflet.Polygon;
}

/** `hitRadiusPx` is a target half-*diameter* for the tap area; the hit triangle is the same shape as the visible glyph, scaled up to reach it. */
function hitSizeMultiplier(widthPx: number, heightPx: number, hitRadiusPx: number): number {
    const largestGlyphDimension = Math.max(widthPx, heightPx);
    return (hitRadiusPx * 2) / largestGlyphDimension;
}

function cornersToLatLngs<T>(
    L: typeof Leaflet,
    map: Leaflet.Map,
    descriptor: GlyphDescriptor<T>,
    widthPx: number,
    heightPx: number,
): Leaflet.LatLng[] {
    const zoom = map.getZoom();
    const centerPixel = map.project(L.latLng(descriptor.lat, descriptor.lng), zoom);
    const corners = rotatedTrianglePoints(widthPx, heightPx, descriptor.heading);
    return corners.map((corner) => map.unproject(L.point(centerPixel.x + corner.x, centerPixel.y + corner.y), zoom));
}

export function createCanvasGlyphLayer<T>(L: typeof Leaflet, map: Leaflet.Map, options: CanvasGlyphLayerOptions<T>): CanvasGlyphLayer<T> {
    const renderer = L.canvas({ padding: 0.5 });
    const layerGroup = L.layerGroup().addTo(map);
    const entries = new Map<string, GlyphEntry>();
    const descriptorsById = new Map<string, GlyphDescriptor<T>>();
    const hitMultiplier = hitSizeMultiplier(options.widthPx, options.heightPx, options.hitRadiusPx);
    let visibleCount = 0;

    function styleFor(descriptor: GlyphDescriptor<T>, opacity: number): { fillOpacity: number; opacity: number } {
        const distinct = options.isDistinct?.(descriptor.data) ?? false;
        const finalOpacity = distinct ? opacity * 0.5 : opacity;
        return { fillOpacity: finalOpacity, opacity: finalOpacity };
    }

    function applyLatLngs(descriptor: GlyphDescriptor<T>, entry: GlyphEntry): void {
        entry.visible.setLatLngs(cornersToLatLngs(L, map, descriptor, options.widthPx, options.heightPx));
        entry.hitArea.setLatLngs(cornersToLatLngs(L, map, descriptor, options.widthPx * hitMultiplier, options.heightPx * hitMultiplier));
    }

    function createEntry(descriptor: GlyphDescriptor<T>): GlyphEntry {
        const visible = L.polygon([], {
            renderer,
            color: options.color,
            fillColor: options.color,
            fillOpacity: 1,
            opacity: 1,
            weight: 1,
            interactive: false,
        });
        const hitArea = L.polygon([], {
            renderer,
            fillOpacity: 0,
            opacity: 0,
            interactive: true,
            bubblingMouseEvents: false,
        });
        hitArea.bindPopup(() => options.buildPopup((descriptorsById.get(descriptor.id) ?? descriptor).data), {
            className: 'live-glyph-popup-wrapper',
            autoPanPadding: [20, 20],
        });
        visible.addTo(layerGroup);
        hitArea.addTo(layerGroup);
        return { visible, hitArea };
    }

    function removeEntry(id: string): void {
        const entry = entries.get(id);
        if (!entry) return;
        layerGroup.removeLayer(entry.visible);
        layerGroup.removeLayer(entry.hitArea);
        entries.delete(id);
        descriptorsById.delete(id);
    }

    function onZoomEnd(): void {
        for (const [id, descriptor] of descriptorsById) {
            const entry = entries.get(id);
            if (entry) applyLatLngs(descriptor, entry);
        }
    }
    map.on('zoomend', onZoomEnd);

    function update(items: readonly GlyphDescriptor<T>[], maxAgeMinutes: number, now: Date): void {
        const visible = visibleGlyphs(items, maxAgeMinutes, now);
        const opacityById = new Map(visible.map((v) => [v.descriptor.id, v.opacity]));
        const diff = diffGlyphs(
            descriptorsById,
            visible.map((v) => v.descriptor),
        );

        for (const descriptor of diff.toAdd) {
            const entry = createEntry(descriptor);
            descriptorsById.set(descriptor.id, descriptor);
            applyLatLngs(descriptor, entry);
            entry.visible.setStyle(styleFor(descriptor, opacityById.get(descriptor.id) ?? 1));
            entries.set(descriptor.id, entry);
        }

        for (const descriptor of diff.toUpdate) {
            descriptorsById.set(descriptor.id, descriptor);
            const entry = entries.get(descriptor.id);
            if (!entry) continue;
            applyLatLngs(descriptor, entry);
            if (entry.hitArea.isPopupOpen()) entry.hitArea.setPopupContent(options.buildPopup(descriptor.data));
        }

        for (const id of diff.toRemove) removeEntry(id);

        // Opacity can change between polls purely from aging, even with
        // no position/heading update -- applied to every surviving entry.
        for (const { descriptor, opacity } of visible) {
            const entry = entries.get(descriptor.id);
            if (entry) entry.visible.setStyle(styleFor(descriptor, opacity));
        }

        visibleCount = visible.length;
    }

    return {
        update,
        count: () => visibleCount,
        dispose(): void {
            map.off('zoomend', onZoomEnd);
            map.removeLayer(layerGroup);
            entries.clear();
            descriptorsById.clear();
        },
    };
}
