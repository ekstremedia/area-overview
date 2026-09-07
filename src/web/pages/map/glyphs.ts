/**
 * Pure, Leaflet-free logic shared by every canvas-rendered live layer
 * (ships, aircraft, and any future one): identity-based diffing (so a
 * poll that changes nothing produces an empty diff, never a full
 * rebuild), age-based opacity/expiry, and the rotated-triangle geometry
 * math. `canvasGlyphLayer.ts` is the only Leaflet-touching consumer of
 * this file -- everything here is unit-tested directly, no map required.
 */

export interface GlyphDescriptor<T> {
    id: string;
    lat: number;
    lng: number;
    /** Compass bearing in degrees (0 = north), the direction the glyph's apex points. */
    heading: number;
    timestamp: string;
    data: T;
}

export interface GlyphDiff<T> {
    toAdd: GlyphDescriptor<T>[];
    toUpdate: GlyphDescriptor<T>[];
    toRemove: string[];
}

function glyphEqual<T>(a: GlyphDescriptor<T>, b: GlyphDescriptor<T>): boolean {
    return a.lat === b.lat && a.lng === b.lng && a.heading === b.heading && a.timestamp === b.timestamp;
}

/**
 * Diffs a previous glyph-descriptor set against the next one, by `id`
 * (MMSI for ships, ICAO hex for aircraft). Pure data in, pure data out --
 * same shape/purpose as `markers.ts`'s `diffMarkers` for camera pins.
 */
export function diffGlyphs<T>(previous: ReadonlyMap<string, GlyphDescriptor<T>>, next: readonly GlyphDescriptor<T>[]): GlyphDiff<T> {
    const nextIds = new Set(next.map((descriptor) => descriptor.id));
    const toAdd: GlyphDescriptor<T>[] = [];
    const toUpdate: GlyphDescriptor<T>[] = [];
    for (const descriptor of next) {
        const existing = previous.get(descriptor.id);
        if (!existing) {
            toAdd.push(descriptor);
        } else if (!glyphEqual(existing, descriptor)) {
            toUpdate.push(descriptor);
        }
    }
    const toRemove = [...previous.keys()].filter((id) => !nextIds.has(id));
    return { toAdd, toUpdate, toRemove };
}

/** A position older than half of `maxAgeMinutes` drops to this opacity. */
export const AGED_OPACITY = 0.42;

export function ageMs(timestamp: string, now: Date): number {
    return now.getTime() - new Date(timestamp).getTime();
}

/** `null` once a position is older than the full `maxAgeMinutes` -- the caller must remove it entirely, not just dim it. */
export function opacityForAge(ageMilliseconds: number, maxAgeMinutes: number): number | null {
    const maxAgeMs = maxAgeMinutes * 60_000;
    if (ageMilliseconds >= maxAgeMs) return null;
    if (ageMilliseconds >= maxAgeMs / 2) return AGED_OPACITY;
    return 1;
}

export interface VisibleGlyph<T> {
    descriptor: GlyphDescriptor<T>;
    opacity: number;
}

/** Filters `items` to those still within `maxAgeMinutes` of `now`, pairing survivors with their age-based opacity. Feeding the result straight into `diffGlyphs` means an aged-out item naturally lands in `toRemove` with no separate expiry pass needed. */
export function visibleGlyphs<T>(items: readonly GlyphDescriptor<T>[], maxAgeMinutes: number, now: Date): VisibleGlyph<T>[] {
    const result: VisibleGlyph<T>[] = [];
    for (const descriptor of items) {
        const opacity = opacityForAge(ageMs(descriptor.timestamp, now), maxAgeMinutes);
        if (opacity !== null) result.push({ descriptor, opacity });
    }
    return result;
}

// --- Rotated-triangle geometry ---

export interface Point2D {
    x: number;
    y: number;
}

/** The three corners (apex first) of an upward-pointing (heading 0 = screen "up") isosceles triangle, centered on the origin, in screen-pixel offsets. */
export function triangleLocalPoints(widthPx: number, heightPx: number): [Point2D, Point2D, Point2D] {
    return [
        { x: 0, y: -heightPx / 2 },
        { x: -widthPx / 2, y: heightPx / 2 },
        { x: widthPx / 2, y: heightPx / 2 },
    ];
}

/** Rotates `point` clockwise by `headingDegrees` (a compass bearing: 0 = up, 90 = right) around the origin, in screen coordinates (y grows downward). */
export function rotatePoint(point: Point2D, headingDegrees: number): Point2D {
    const theta = (headingDegrees * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

/** The three rotated corners (apex first) of a `widthPx`x`heightPx` triangle pointing toward `headingDegrees`, as screen-pixel offsets from its center. */
export function rotatedTrianglePoints(widthPx: number, heightPx: number, headingDegrees: number): [Point2D, Point2D, Point2D] {
    const [apex, left, right] = triangleLocalPoints(widthPx, heightPx);
    return [rotatePoint(apex, headingDegrees), rotatePoint(left, headingDegrees), rotatePoint(right, headingDegrees)];
}

/**
 * A plane seen from above, nose up, centred on the origin and scaled to
 * fit `widthPx` (wingspan) by `heightPx` (nose to tail).
 *
 * Ships stay triangles; aircraft get a silhouette because on a wall
 * display the two layers had to be told apart at a glance and colour
 * alone was doing all the work. Drawn as one closed outline -- nose, down
 * the leading edge to a wingtip, back in to the body, out to the
 * tailplane and back -- so it renders through exactly the same
 * `L.Polygon` machinery as the triangle, and rotates the same way.
 *
 * The coordinates are fractions of the bounding box rather than absolute
 * pixels, so the shape survives being scaled up for the invisible
 * hit-target polygon that sits underneath it.
 */
export function planeLocalPoints(widthPx: number, heightPx: number): Point2D[] {
    const halfWidth = widthPx / 2;
    const halfHeight = heightPx / 2;
    // x across the wings, y nose(-) to tail(+).
    const outline: [number, number][] = [
        [0, -1], // nose
        [0.12, -0.55],
        [0.12, -0.3],
        [1, 0.1], // starboard wingtip
        [1, 0.32],
        [0.12, 0.16],
        [0.12, 0.62],
        [0.4, 0.9], // starboard tailplane
        [0.4, 1],
        [0, 0.84],
        [-0.4, 1],
        [-0.4, 0.9], // port tailplane
        [-0.12, 0.62],
        [-0.12, 0.16],
        [-1, 0.32],
        [-1, 0.1], // port wingtip
        [-0.12, -0.3],
        [-0.12, -0.55],
    ];
    return outline.map(([x, y]) => ({ x: x * halfWidth, y: y * halfHeight }));
}

/** `planeLocalPoints` rotated to point along `headingDegrees`, in screen-pixel offsets from its centre. */
export function rotatedPlanePoints(widthPx: number, heightPx: number, headingDegrees: number): Point2D[] {
    return planeLocalPoints(widthPx, heightPx).map((point) => rotatePoint(point, headingDegrees));
}
