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
    /** Folds a poll's worth of records in: appends any new position, drops what has aged out (for every vessel, not only those in this poll), and forgets vessels long gone. */
    record(items: readonly T[], now: Date): void;
    /**
     * The remembered positions for one vessel, oldest first, excluding the
     * one it is reporting now.
     *
     * Takes `now` and filters on it rather than trusting what is stored:
     * during a total upstream outage no poll lands, so nothing ages, and
     * the outage fallback would otherwise hand out positions from before
     * the window it promises.
     */
    trailFor(id: string, now: Date): TrailPoint[];
    /**
     * Every vessel last seen inside `bbox`, as its most recent full record
     * -- the fallback when an upstream is down.
     *
     * Takes `now` for the same reason `trailFor` does: `record` is what
     * forgets vessels, and during a total outage no poll lands, so nothing
     * would ever be forgotten. Without this the fallback could keep
     * serving a vessel hours after the store promised to have dropped it.
     */
    latestIn(bbox: Bbox, now: Date): T[];
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

    /** Points still inside the window, measured against wall-clock `nowMs`. */
    function fresh(points: readonly TrailPoint[], nowMs: number): TrailPoint[] {
        const cutoffMs = nowMs - options.maxAgeMs;
        return points.filter((point) => Date.parse(point.at) >= cutoffMs);
    }

    function appendPoint(points: readonly TrailPoint[], next: TrailPoint, nowMs: number): TrailPoint[] {
        // Measured against wall-clock time, not against `next.at`: a fix
        // that never advances would otherwise hold its own cutoff still
        // and keep a long-dead trail alive forever.
        const kept = fresh(points, nowMs);
        // A vessel at a berth reports the same fix every poll, and an
        // upstream that has heard nothing new re-serves the previous one.
        // Neither is movement, and stacking them would push the real
        // history out of the cap. Judged against what survived ageing: a
        // vessel stationary long enough for its only point to expire would
        // otherwise have the fresh fix rejected as a repeat of the expired
        // one, leaving nothing for its next movement to draw from.
        const newest = kept[kept.length - 1];
        const isRepeat = newest !== undefined && ((newest.lat === next.lat && newest.lng === next.lng) || newest.at === next.at);
        // And a fix can arrive already older than the window -- upstream
        // re-serves positions hours old. Appending one would place a point
        // outside the window at the newest end, where ageing never looks
        // again. The vessel itself is still recorded as `latest`.
        const nextIsFresh = Date.parse(next.at) >= nowMs - options.maxAgeMs;
        const withNext = isRepeat || !nextIsFresh ? kept : [...kept, next];
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
            if (nowMs - entry.lastSeenMs >= options.forgetAfterMs) {
                entries.delete(id);
                continue;
            }
            // Ageing must reach vessels that were absent from this poll
            // too. Their full record is kept until `forgetAfterMs` (the
            // outage fallback needs it), but their *history* is bounded by
            // the same window as everyone else's.
            entry.points = fresh(entry.points, nowMs);
        }
    }

    return {
        record,
        trailFor(id: string, now: Date): TrailPoint[] {
            const entry = entries.get(id);
            if (!entry) return [];
            // Everything but the current position: the caller is already
            // rendering that as the vessel itself.
            return fresh(entry.points, now.getTime()).slice(0, -1);
        },
        latestIn(bbox: Bbox, now: Date): T[] {
            const nowMs = now.getTime();
            const inside: T[] = [];
            for (const entry of entries.values()) {
                if (nowMs - entry.lastSeenMs >= options.forgetAfterMs) continue;
                const { lat, lng } = shape.positionOf(entry.latest);
                if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) continue;
                inside.push(entry.latest);
            }
            return inside;
        },
        size: () => entries.size,
    };
}
