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
import { sharedCanvasRenderer } from './canvasRenderer.js';
import { diffGlyphs, rotatedPlanePoints, rotatedTrianglePoints, visibleGlyphs, type GlyphDescriptor } from './glyphs.js';
import { projectPosition, type Velocity } from './motion.js';

export interface CanvasGlyphLayerOptions<T> {
    /** A literal colour string -- see `liveLayerColors.ts`'s doc comment for why this can't be a CSS custom property. */
    color: string;
    widthPx: number;
    heightPx: number;
    /** Half-width, in px, of the invisible hit-target triangle -- >= 22 gives a >= 44px tap diameter. */
    hitRadiusPx: number;
    /** The silhouette each glyph is drawn as. Ships are triangles; aircraft are planes, so the two layers separate at a glance rather than by colour alone. Defaults to the triangle. */
    shape?: 'triangle' | 'plane';
    buildPopup: (data: T) => HTMLElement;
    /** True for a glyph that should render distinctly/dimmed (e.g. an aircraft reporting from the ground). Defaults to never-distinct. */
    isDistinct?: (data: T) => boolean;
    /**
     * Per-glyph colour override, applied instead of the flat `color` when
     * present (ships' navigational-status colouring; aircraft passes
     * nothing and keeps the flat `color` unaffected). Consulted both at
     * creation (`createEntry`) and on every subsequent `update()` call
     * (`styleFor`), since a glyph's underlying status -- not just its
     * position/heading -- can change between polls.
     */
    colorFor?: (data: T) => string;
    /**
     * Per-glyph permanent-label text -- a ship's name (underway ships
     * only, `ships.ts`'s `shipLabel`) or an aircraft's callsign
     * (`aircraft.ts`'s `aircraftLabel`, every aircraft). `null`/empty
     * means no label. Bound to the same `hitArea` polygon `buildPopup`
     * already uses (Leaflet permits both a popup and a permanent tooltip
     * on one layer), as an `L.Tooltip`, not drawn on the canvas itself --
     * simpler than hand-rolled canvas text, and this project already
     * leans on Leaflet's own layer machinery for the interactive half of
     * a glyph. Consulted both at creation (`createEntry`) and on every
     * subsequent `update()` call, same reasoning as `colorFor`: a ship's
     * navigational status (and therefore whether it should be labelled
     * at all) can change between polls with no change to lat/lng/heading/
     * timestamp, which `diffGlyphs` wouldn't otherwise flag as an update.
     */
    labelFor?: (data: T) => string | null;
    /**
     * How fast, and which way, this thing is actually travelling -- its
     * speed and course over ground, or `null` when the broadcast says
     * nothing usable. Given one, the layer dead-reckons the glyph forward
     * between polls (`motion.ts`) instead of leaving it parked on its last
     * fix until the next one lands, which read as a broken map rather than
     * a slow one: everything sat still for ten seconds and then jumped.
     *
     * Course, not heading: a ship's bow can point somewhere its track does
     * not (a ferry crabbing across a current), and it is the track that
     * says where it will be. The glyph still *points* along
     * `descriptor.heading`.
     *
     * Omitted entirely, the layer draws every glyph exactly where its fix
     * put it, as it always did.
     */
    velocityFor?: (data: T) => Velocity | null;
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
    /** The currently-bound tooltip text, or `null` when none is bound -- lets `applyLabel` tell "no label" from "same label" from "changed label" without asking Leaflet. */
    label: string | null;
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
    shape: 'triangle' | 'plane',
): Leaflet.LatLng[] {
    const zoom = map.getZoom();
    const centerPixel = map.project(L.latLng(descriptor.lat, descriptor.lng), zoom);
    const corners =
        shape === 'plane' ? rotatedPlanePoints(widthPx, heightPx, descriptor.heading) : rotatedTrianglePoints(widthPx, heightPx, descriptor.heading);
    return corners.map((corner) => map.unproject(L.point(centerPixel.x + corner.x, centerPixel.y + corner.y), zoom));
}

/**
 * How often a dead-reckoned glyph is redrawn.
 *
 * A compromise, and the kiosk is what it is picked for: at 8 frames a
 * second an airliner moves well under a pixel per frame at the map's
 * usual zoom, so the motion reads as gliding rather than stepping, while
 * a Raspberry Pi redraws the whole canvas eight times a second instead of
 * sixty.
 */
const MOTION_FRAME_MS = 120;

export function createCanvasGlyphLayer<T>(L: typeof Leaflet, map: Leaflet.Map, options: CanvasGlyphLayerOptions<T>): CanvasGlyphLayer<T> {
    // Shared with every other path layer on this map, trails included --
    // see `canvasRenderer.ts` for why a renderer of its own would make
    // these glyphs unclickable.
    const renderer = sharedCanvasRenderer(L, map);
    const layerGroup = L.layerGroup().addTo(map);
    const entries = new Map<string, GlyphEntry>();
    const descriptorsById = new Map<string, GlyphDescriptor<T>>();
    const hitMultiplier = hitSizeMultiplier(options.widthPx, options.heightPx, options.hitRadiusPx);
    const shape = options.shape ?? 'triangle';
    let visibleCount = 0;

    function styleFor(descriptor: GlyphDescriptor<T>, opacity: number): { fillOpacity: number; opacity: number; color: string; fillColor: string } {
        const distinct = options.isDistinct?.(descriptor.data) ?? false;
        const finalOpacity = distinct ? opacity * 0.5 : opacity;
        const color = options.colorFor?.(descriptor.data) ?? options.color;
        return { fillOpacity: finalOpacity, opacity: finalOpacity, color, fillColor: color };
    }

    /**
     * Small offset so a permanent right-hand tooltip clears the triangle
     * itself rather than overlapping its heading indicator.
     *
     * `interactive: true` makes the label a tap target in its own right:
     * Leaflet forwards its clicks to the layer the tooltip belongs to,
     * which is `hitArea` -- the same polygon `buildPopup` is bound to --
     * so tapping a ship's name opens exactly the popup tapping its
     * triangle does. On a touchscreen the name is a far easier target
     * than a 14x19px triangle, which is the point. `map.css` grows the
     * label's tappable box to this app's 44px minimum without changing
     * how it looks.
     */
    const labelTooltipOptions: Leaflet.TooltipOptions = {
        permanent: true,
        direction: 'right',
        offset: L.point(8, 0),
        className: 'glyph-label',
        interactive: true,
    };

    /**
     * Leaflet's `bindTooltip`/`setTooltipContent` treat a `string` argument
     * as HTML (`innerHTML`), not text -- a ship name or aircraft callsign
     * is API-derived (an AIS/ADS-B broadcast this app never validates),
     * so passing one through as a raw string would let it inject markup
     * into the map page. An `HTMLElement` argument is inserted as a real
     * node instead, with no HTML parsing, so `textContent` here is what
     * actually keeps the label as text.
     */
    function labelElement(text: string): HTMLElement {
        const el = document.createElement('span');
        el.textContent = text;
        return el;
    }

    /** Binds/replaces/unbinds `entry.hitArea`'s permanent tooltip to match `options.labelFor(descriptor.data)`'s current result -- a no-op when the label hasn't changed since the last call. */
    function applyLabel(entry: GlyphEntry, descriptor: GlyphDescriptor<T>): void {
        const raw = options.labelFor?.(descriptor.data) ?? null;
        const label = raw !== null && raw !== '' ? raw : null;
        if (label === entry.label) return;
        if (label === null) {
            entry.hitArea.unbindTooltip();
        } else if (entry.label === null) {
            entry.hitArea.bindTooltip(labelElement(label), labelTooltipOptions);
        } else {
            entry.hitArea.setTooltipContent(labelElement(label));
        }
        entry.label = label;
        // Anchor here too, not only from `applyLatLngs`: a label can appear
        // long after the glyph did (a ship that gets under way without
        // having moved yet), and Leaflet anchors a freshly-bound tooltip at
        // `Polygon.getCenter()` -- the middle of the rotated triangle, not
        // the vessel. Nothing would correct that until the vessel next
        // moved.
        if (label !== null) anchorLabel(descriptor, entry);
    }

    /**
     * Pins an open label to the glyph's own coordinates.
     *
     * Leaflet anchors a tooltip once, when it opens, and then only
     * re-anchors on its layer's `move` event -- which `L.Marker` fires from
     * `setLatLng` but a path never fires from `setLatLngs`. So a name label
     * stayed behind at the vessel's old position while the triangle sailed
     * away, the two drifting further apart with every poll. Using the
     * descriptor's own lat/lng rather than the polygon centroid Leaflet
     * would compute for itself also keeps the tag pinned to the vessel
     * rather than to the middle of its heading-rotated triangle.
     */
    function anchorLabel(descriptor: GlyphDescriptor<T>, entry: GlyphEntry): void {
        entry.hitArea.getTooltip()?.setLatLng(L.latLng(descriptor.lat, descriptor.lng));
    }

    /**
     * Where this glyph has got to since the fix it was last reported at
     * -- the same descriptor with its position dead-reckoned forward (see
     * `motion.ts`). Without a `velocityFor`, or for anything that isn't
     * moving, this is the descriptor itself, and every drawing path below
     * behaves exactly as it did before there was any motion at all.
     */
    function projected(descriptor: GlyphDescriptor<T>): GlyphDescriptor<T> {
        if (!options.velocityFor) return descriptor;
        const fixMs = Date.parse(descriptor.timestamp);
        if (Number.isNaN(fixMs)) return descriptor;

        const at = projectPosition({ lat: descriptor.lat, lng: descriptor.lng }, options.velocityFor(descriptor.data), Date.now() - fixMs);
        if (at.lat === descriptor.lat && at.lng === descriptor.lng) return descriptor;
        return { ...descriptor, lat: at.lat, lng: at.lng };
    }

    function applyLatLngs(descriptor: GlyphDescriptor<T>, entry: GlyphEntry): void {
        const at = projected(descriptor);
        entry.visible.setLatLngs(cornersToLatLngs(L, map, at, options.widthPx, options.heightPx, shape));
        entry.hitArea.setLatLngs(cornersToLatLngs(L, map, at, options.widthPx * hitMultiplier, options.heightPx * hitMultiplier, shape));
        anchorLabel(at, entry);
    }

    /**
     * Both polygons are built with their real corners up front rather than
     * as empty `L.polygon([])`s filled in by a later `setLatLngs`: a
     * permanent tooltip (`applyLabel`, below) is opened by Leaflet the
     * instant it is bound to a layer that is already on the map, and
     * opening one resolves its anchor through `Polygon.getCenter()`, which
     * throws `latlngs not passed` on a polygon that has no points yet.
     * That threw for real, in production, on every labelled glyph -- and
     * because the throw escaped mid-`update()`, it took the whole ships
     * layer with it (no glyphs, a stuck `0 skip` count, no attribution)
     * while leaving the already-added polygons orphaned on the map. Never
     * letting a glyph exist in an empty state is what keeps that safe,
     * independently of the order the calls below happen to be in.
     */
    function createEntry(descriptor: GlyphDescriptor<T>): GlyphEntry {
        const color = options.colorFor?.(descriptor.data) ?? options.color;
        // Positioned where the vessel is *now*, not where its fix was
        // taken: a glyph arriving from a 40-second-old fix would otherwise
        // appear behind itself and then jump forward on the first frame.
        const at = projected(descriptor);
        const visible = L.polygon(cornersToLatLngs(L, map, at, options.widthPx, options.heightPx, shape), {
            renderer,
            color,
            fillColor: color,
            fillOpacity: 1,
            opacity: 1,
            weight: 1,
            interactive: false,
        });
        const hitArea = L.polygon(cornersToLatLngs(L, map, at, options.widthPx * hitMultiplier, options.heightPx * hitMultiplier, shape), {
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
        const entry: GlyphEntry = { visible, hitArea, label: null };
        applyLabel(entry, at); // anchors the label itself when it binds one
        return entry;
    }

    function removeEntry(id: string): void {
        const entry = entries.get(id);
        if (!entry) return;
        layerGroup.removeLayer(entry.visible);
        layerGroup.removeLayer(entry.hitArea);
        entries.delete(id);
        descriptorsById.delete(id);
    }

    function redrawAll(): void {
        for (const [id, descriptor] of descriptorsById) {
            const entry = entries.get(id);
            if (entry) applyLatLngs(descriptor, entry);
        }
    }

    function onZoomEnd(): void {
        redrawAll();
    }
    map.on('zoomend', onZoomEnd);

    // The glyphs move between polls, not only on them. Skipped while the
    // tab is hidden: nothing is on screen to glide, and a kiosk left on a
    // background tab should not be redrawing a canvas eight times a
    // second for nobody.
    const motionTimer =
        options.velocityFor === undefined
            ? undefined
            : setInterval(() => {
                  if (document.hidden) return;
                  redrawAll();
              }, MOTION_FRAME_MS);

    function update(items: readonly GlyphDescriptor<T>[], maxAgeMinutes: number, now: Date): void {
        const visible = visibleGlyphs(items, maxAgeMinutes, now);
        const opacityById = new Map(visible.map((v) => [v.descriptor.id, v.opacity]));
        const diff = diffGlyphs(
            descriptorsById,
            visible.map((v) => v.descriptor),
        );

        for (const descriptor of diff.toAdd) {
            // No `applyLatLngs` here -- `createEntry` builds both polygons
            // already positioned (see its doc comment).
            const entry = createEntry(descriptor);
            descriptorsById.set(descriptor.id, descriptor);
            entry.visible.setStyle(styleFor(descriptor, opacityById.get(descriptor.id) ?? 1));
            entries.set(descriptor.id, entry);
        }

        for (const descriptor of diff.toUpdate) {
            descriptorsById.set(descriptor.id, descriptor);
            const entry = entries.get(descriptor.id);
            if (!entry) continue;
            applyLatLngs(descriptor, entry);
            if (entry.hitArea.isPopupOpen()) entry.hitArea.setPopupContent(options.buildPopup(descriptor.data));
            applyLabel(entry, descriptor);
        }

        for (const id of diff.toRemove) removeEntry(id);

        // Opacity (and, independently, the label) can change between polls
        // purely from a status change, even with no position/heading/
        // timestamp update -- both applied to every surviving entry, not
        // just the ones `diffGlyphs` flagged as `toUpdate`.
        for (const { descriptor, opacity } of visible) {
            const entry = entries.get(descriptor.id);
            if (!entry) continue;
            entry.visible.setStyle(styleFor(descriptor, opacity));
            applyLabel(entry, descriptor);
        }

        visibleCount = visible.length;
    }

    return {
        update,
        count: () => visibleCount,
        dispose(): void {
            if (motionTimer !== undefined) clearInterval(motionTimer);
            map.off('zoomend', onZoomEnd);
            map.removeLayer(layerGroup);
            entries.clear();
            descriptorsById.clear();
        },
    };
}
