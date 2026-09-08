/**
 * The one `L.Canvas` every path layer on a map draws into.
 *
 * Leaflet gives each `L.canvas()` renderer its own `<canvas>`, stretched
 * across the whole overlay pane. Two renderers therefore means two
 * full-size canvases stacked on top of each other, and the topmost one
 * takes every click: the browser hits the element, not the pixels, and a
 * canvas has no transparent regions as far as hit-testing is concerned.
 *
 * That is exactly what happened here. Ships drew their triangles through
 * one renderer and their trails through another, so the trail canvas --
 * added second, and so on top -- swallowed every tap aimed at a vessel.
 * The trail segments themselves are already `interactive: false`, which
 * is the right intent and no help at all: the canvas element covering
 * them is what the finger lands on. Only ships under way were reachable,
 * and only because their name label is real DOM in the tooltip pane
 * above; a moored vessel, which gets no label, could not be opened at
 * all.
 *
 * One renderer per map fixes it at the root: everything lands in a single
 * canvas, and Leaflet's own hit test walks the paths in it -- skipping
 * the non-interactive trails and finding the glyph's hit area beneath, as
 * it was always meant to. Keyed by map rather than module-global so a
 * remount (or a second map) gets its own, and the entry dies with the map
 * it belongs to.
 */
import type * as Leaflet from 'leaflet';

const renderers = new WeakMap<Leaflet.Map, Leaflet.Canvas>();

/**
 * `padding: 0.5` keeps half a viewport of drawn area outside the visible
 * map, so a glyph stays painted while the map is panned before the
 * renderer catches up -- the value every layer here used when they each
 * made their own.
 */
export function sharedCanvasRenderer(L: typeof Leaflet, map: Leaflet.Map): Leaflet.Canvas {
    const existing = renderers.get(map);
    if (existing) return existing;

    const renderer = L.canvas({ padding: 0.5 });
    renderers.set(map, renderer);
    return renderer;
}
