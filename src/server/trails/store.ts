/**
 * The BFF's memory of where ships and aircraft have recently been.
 *
 * Neither upstream serves history, so somebody has to remember. Doing it
 * here rather than in the browser is what makes a trail survive leaving
 * the map page, and what lets a trail already exist when the kiosk cycles
 * back to the map after some minutes on another page -- the poller
 * (`poller.ts`) keeps feeding this store while nobody is looking.
 *
 * The store also doubles as the last-known-good snapshot the routes fall
 * back to when an upstream is unreachable: it holds each vessel's most
 * recent full record, not just its coordinates, so `/api/ships` can still
 * answer with real vessels during a BarentsWatch outage instead of an
 * error.
 *
 * In memory only, deliberately. A restart loses the trails, and they
 * rebuild within a few polls; persisting them would mean owning a
 * write-often store on a kiosk box for something that is decorative
 * within minutes of boot.
 */
import type { TrailPoint } from '../../shared/schemas/trail.js';
import type { Bbox } from '../layers/bbox.js';

export interface TrailStoreOptions {
    /** Positions kept per vessel. Older ones fall off the front as new ones arrive. */
    maxPoints: number;
    /** Positions older than this are dropped, so a vessel that goes quiet and returns hours later gets no line ruled across the gap. */
    maxAgeMs: number;
    /** A vessel not seen in any poll for this long is forgotten entirely -- the bound on what a box running for weeks holds. */
    forgetAfterMs: number;
}

export interface TrailStore<T> {
    /** Folds a poll's worth of records in: appends any new position, drops what has aged out, and forgets vessels long gone. */
    record(items: readonly T[], now: Date): void;
    /** The remembered positions for one vessel, oldest first, excluding the one it is reporting now. */
    trailFor(id: string): TrailPoint[];
    /** Every vessel last seen inside `bbox`, as its most recent full record -- the fallback when an upstream is down. */
    latestIn(bbox: Bbox): T[];
    /** Vessels currently remembered. For logging and tests; not a public API surface. */
    size(): number;
}

interface Entry<T> {
    latest: T;
    /** Includes the vessel's current position as its last element; `trailFor` drops that, since the caller already has it. */
    points: TrailPoint[];
    lastSeenMs: number;
}

export interface TrailStoreShape<T> {
    idOf: (item: T) => string;
    positionOf: (item: T) => TrailPoint;
}

export function createTrailStore<T>(shape: TrailStoreShape<T>, options: TrailStoreOptions): TrailStore<T> {
    const entries = new Map<string, Entry<T>>();

    function appendPoint(points: readonly TrailPoint[], next: TrailPoint, nowMs: number): TrailPoint[] {
        const newest = points[points.length - 1];
        // A vessel at a berth reports the same fix every poll, and an
        // upstream that has heard nothing new re-serves the previous one.
        // Neither is movement, and stacking them would push the real
        // history out of the cap.
        const isRepeat = newest !== undefined && ((newest.lat === next.lat && newest.lng === next.lng) || newest.at === next.at);
        const cutoffMs = nowMs - options.maxAgeMs;
        // Measured against wall-clock time, not against `next.at`: a fix
        // that never advances would otherwise hold its own cutoff still
        // and keep a long-dead trail alive forever.
        const kept = points.filter((point) => Date.parse(point.at) >= cutoffMs);
        const withNext = isRepeat ? kept : [...kept, next];
        return withNext.length > options.maxPoints ? withNext.slice(withNext.length - options.maxPoints) : withNext;
    }

    function record(items: readonly T[], now: Date): void {
        const nowMs = now.getTime();

        for (const item of items) {
            const id = shape.idOf(item);
            const position = shape.positionOf(item);
            // An unparseable timestamp would compare false against every
            // cutoff, so the point would never age out. Such a record is
            // still kept as `latest` (it is a real vessel, and the routes
            // may need to serve it) but contributes no history.
            if (Number.isNaN(Date.parse(position.at))) {
                const existing = entries.get(id);
                entries.set(id, { latest: item, points: existing?.points ?? [], lastSeenMs: nowMs });
                continue;
            }

            const existing = entries.get(id);
            entries.set(id, {
                latest: item,
                points: appendPoint(existing?.points ?? [], position, nowMs),
                lastSeenMs: nowMs,
            });
        }

        for (const [id, entry] of entries) {
            if (nowMs - entry.lastSeenMs < options.forgetAfterMs) continue;
            entries.delete(id);
        }
    }

    return {
        record,
        trailFor(id: string): TrailPoint[] {
            const entry = entries.get(id);
            if (!entry) return [];
            // Everything but the current position: the caller is already
            // rendering that as the vessel itself.
            return entry.points.slice(0, -1);
        },
        latestIn(bbox: Bbox): T[] {
            const inside: T[] = [];
            for (const entry of entries.values()) {
                const { lat, lng } = shape.positionOf(entry.latest);
                if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) continue;
                inside.push(entry.latest);
            }
            return inside;
        },
        size: () => entries.size,
    };
}
