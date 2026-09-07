/**
 * The fading tail behind each moving ship/aircraft: the Leaflet-touching
 * half of `trails.ts`'s pure history/fade logic, and a sibling of
 * `canvasGlyphLayer.ts` rather than a part of it.
 *
 * Kept separate for one substantive reason: `canvasGlyphLayer` only ever
 * sees the glyphs actually drawn as triangles, and `ships.ts` withholds
 * clustered ships from it (they become one badge instead). A trail fed
 * from that set would be erased every time its ship joined a cluster and
 * would restart from nothing when it left again -- and clusters form and
 * dissolve on every zoom. This layer is fed the full visible set instead,
 * so history accumulates per MMSI/ICAO regardless of how a vessel happens
 * to be drawn at the moment.
 *
 * Each segment is its own `L.Polyline` because the fade is per-segment:
 * Leaflet's canvas renderer strokes a path in one flat colour, so a
 * gradient along a single polyline isn't available without hand-rolling a
 * canvas layer -- which this codebase deliberately avoids (see
 * `canvasGlyphLayer.ts`'s doc comment for the same trade-off). All
 * segments share one `L.Canvas` renderer with the map's other paths, so
 * this is still one `<canvas>`, not one DOM node per segment. Unlike the
 * glyph triangles, a segment's geometry is genuinely geographic, so
 * Leaflet reprojects it across zooms for free and no `zoomend` recompute
 * is needed here.
 */
import type * as Leaflet from 'leaflet';
import type { GlyphDescriptor } from './glyphs.js';
import { appendTrailPoint, trailSegments, type TrailPoint } from './trails.js';

/**
 * ~5 minutes of ship track at the 15s default poll, ~3 of aircraft at 10s.
 * Chosen against the kiosk's own view rather than in the abstract: it
 * spans roughly 24km across ~1000px there, so a 10-knot vessel covers
 * about 12px per minute. Ten points (2.5 min) drew a tail barely longer
 * than the glyph itself; twenty reads clearly as a tail at that scale
 * while still being the "little" one asked for, not a snake across the
 * fjord. Only a vessel that actually moves accumulates points, so the
 * segment count stays proportional to what is underway, not to what is
 * on screen.
 */
const MAX_POINTS = 20;

/** Points older than this are dropped outright, so a vessel that drops out of coverage and returns doesn't get a straight line ruled across the gap. */
const MAX_AGE_MS = 15 * 60_000;

/** A trail whose glyph hasn't been seen for this long is forgotten entirely -- the cap on what a kiosk running for weeks retains. */
const FORGET_AFTER_MS = 20 * 60_000;

/**
 * The near end sits just behind the glyph and has to read from across the
 * room on a 1024x600 kiosk, so it is drawn close to solid; the far end
 * trails off to almost nothing, which is what makes the tail point back
 * the way the vessel came rather than looking like a drawn route. Checked
 * against a real render: at 0.55 the whole tail was too easily lost
 * against the dark basemap.
 */
const NEWEST_OPACITY = 0.8;
const OLDEST_OPACITY = 0.05;
const TRAIL_WEIGHT_PX = 2.5;

interface TrailEntry<T> {
    points: TrailPoint[];
    /** The glyph's latest payload, kept only so `colorFor` can be consulted at redraw time. */
    data: T;
    /** The rendered segments, kept so they can be removed before redrawing. */
    lines: Leaflet.Polyline[];
    lastSeen: number;
}

export interface TrailLayer<T> {
    /** Applies the full set of currently-visible glyphs -- appends a point per glyph that moved, redraws only the trails that changed, and forgets glyphs long gone. */
    update(descriptors: readonly GlyphDescriptor<T>[], now: Date): void;
    /** Erases every trail and the history behind it, for a layer that has gone from showing data to showing none (an upstream reporting itself unconfigured). Not the same as an empty `update`, which keeps trails standing so a ship missing from one poll doesn't lose its tail. */
    clear(): void;
    dispose(): void;
}

export interface TrailLayerOptions<T> {
    /** A literal colour string -- see `liveLayerColors.ts` for why this can't be a CSS custom property. */
    color: string;
    /**
     * Per-glyph colour override, so a tail matches the glyph it trails
     * from (ships colour by navigational status; aircraft pass nothing and
     * keep the flat `color`). Consulted on each redraw -- which happens
     * whenever the vessel moved, so for anything actually under way the
     * colour tracks its status as closely as the glyph's own does. A
     * status change with no movement leaves the existing tail as it was,
     * which is the right call anyway: those segments were travelled under
     * the old status.
     */
    colorFor?: (data: T) => string;
}

export function createTrailLayer<T>(L: typeof Leaflet, map: Leaflet.Map, options: TrailLayerOptions<T>): TrailLayer<T> {
    const renderer = L.canvas({ padding: 0.5 });
    const layerGroup = L.layerGroup().addTo(map);
    const entries = new Map<string, TrailEntry<T>>();

    function clearLines(entry: TrailEntry<T>): void {
        for (const line of entry.lines) layerGroup.removeLayer(line);
        entry.lines = [];
    }

    function drawTrail(entry: TrailEntry<T>): void {
        clearLines(entry);
        const color = options.colorFor?.(entry.data) ?? options.color;
        for (const segment of trailSegments(entry.points, { newestOpacity: NEWEST_OPACITY, oldestOpacity: OLDEST_OPACITY })) {
            const line = L.polyline(
                [
                    [segment.from.lat, segment.from.lng],
                    [segment.to.lat, segment.to.lng],
                ],
                {
                    renderer,
                    color,
                    weight: TRAIL_WEIGHT_PX,
                    opacity: segment.opacity,
                    // The tail is scenery: it must never sit between a
                    // finger and the glyph's own 44px tap target.
                    interactive: false,
                },
            );
            line.addTo(layerGroup);
            entry.lines.push(line);
        }
    }

    function update(descriptors: readonly GlyphDescriptor<T>[], now: Date): void {
        const nowMs = now.getTime();

        for (const descriptor of descriptors) {
            const reportedAt = new Date(descriptor.timestamp).getTime();
            // An unparseable timestamp would poison every age comparison
            // below (`NaN` compares false against everything, so the point
            // would neither age out nor sort), so such a fix is simply not
            // recorded -- the glyph itself still draws.
            if (Number.isNaN(reportedAt)) continue;

            const entry: TrailEntry<T> = entries.get(descriptor.id) ?? {
                points: [],
                data: descriptor.data,
                lines: [],
                lastSeen: nowMs,
            };
            entry.data = descriptor.data;
            const before = entry.points;
            entry.points = appendTrailPoint(
                entry.points,
                { lat: descriptor.lat, lng: descriptor.lng, at: reportedAt },
                { maxPoints: MAX_POINTS, maxAgeMs: MAX_AGE_MS, now: nowMs },
            );
            entry.lastSeen = nowMs;
            entries.set(descriptor.id, entry);

            // Identity, not the newest timestamp: `appendTrailPoint` hands
            // back the very same array when nothing changed, and a different
            // one whenever anything did -- including an ageing pass that only
            // dropped old points, which leaves the newest timestamp untouched
            // while making the drawn trail wrong.
            if (entry.points !== before) drawTrail(entry);
        }

        for (const [id, entry] of entries) {
            if (nowMs - entry.lastSeen < FORGET_AFTER_MS) continue;
            clearLines(entry);
            entries.delete(id);
        }
    }

    function clear(): void {
        for (const entry of entries.values()) clearLines(entry);
        entries.clear();
    }

    return {
        update,
        clear,
        dispose(): void {
            map.removeLayer(layerGroup);
            entries.clear();
        },
    };
}
