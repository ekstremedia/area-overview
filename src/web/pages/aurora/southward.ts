/**
 * How long the interplanetary magnetic field's Bz component has been
 * pointing south.
 *
 * Southward Bz is the single best short-term hint that the aurora will
 * actually show: it lets the solar wind couple to Earth's field. The Bz
 * *number* is already on the page, but "−8.4 nT" says nothing about
 * whether that just happened or has been true all evening, and the
 * duration is what tells you whether it is worth going outside.
 *
 * `solarWind.mag` is passed through unvalidated by the aurora schema
 * (an upstream-specific shape this app doesn't otherwise consume), so
 * everything here is defensive: anything that isn't a well-formed point
 * is skipped rather than trusted.
 */

export interface SouthwardRun {
    /** Whole minutes Bz has been continuously southward, counting back from the newest reading. */
    minutes: number;
    /**
     * True when the run reaches the oldest reading available, so the real
     * duration is only known to be *at least* this long. The upstream
     * window is about an hour, so a genuinely long southward spell always
     * lands here -- claiming a precise "4 t" from a 54-minute series would
     * be inventing data.
     */
    atLeast: boolean;
}

interface MagPoint {
    time: number;
    bz: number;
}

/** Pulls the well-formed `{time, bz}` points out of the unvalidated `mag` blob, oldest first. */
function readPoints(mag: unknown): MagPoint[] {
    if (typeof mag !== 'object' || mag === null) return [];
    const raw = (mag as { points?: unknown }).points;
    if (!Array.isArray(raw)) return [];

    const points: MagPoint[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { time, bz } = entry as { time?: unknown; bz?: unknown };
        if (typeof time !== 'string' || typeof bz !== 'number') continue;
        const parsed = Date.parse(time);
        if (Number.isNaN(parsed)) continue;
        points.push({ time: parsed, bz });
    }
    points.sort((a, b) => a.time - b.time);
    return points;
}

/**
 * The current southward run, or `null` when Bz is northward right now (or
 * there is nothing usable to read) -- in which case the caller shows
 * nothing at all rather than "0 minutes", which would read as a fact
 * about the aurora rather than the absence of one.
 *
 * Bz of exactly 0 counts as not-southward: it is the neutral case, and
 * calling it southward would overstate the odds.
 */
export function southwardRun(mag: unknown): SouthwardRun | null {
    const points = readPoints(mag);
    const newest = points[points.length - 1];
    if (!newest || newest.bz >= 0) return null;

    let index = points.length - 1;
    for (;;) {
        const previous = points[index - 1];
        if (previous === undefined || previous.bz >= 0) break;
        index -= 1;
    }

    const runStart = points[index];
    if (runStart === undefined) return null; // unreachable: `newest` proves the array is non-empty
    const minutes = Math.max(1, Math.round((newest.time - runStart.time) / 60_000));
    return { minutes, atLeast: index === 0 };
}
