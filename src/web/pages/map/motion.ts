/**
 * Dead reckoning: where a vessel or aircraft has got to since its last
 * reported fix, given the speed and course that fix came with.
 *
 * The upstreams answer every 10-30 seconds, so without this a ship sits
 * perfectly still and then teleports, which on a wall display reads as a
 * broken map rather than a slow one. Between fixes the glyph is moved
 * along its own course at its own speed -- a prediction, corrected the
 * moment the next real position arrives.
 *
 * Deliberately naive: a straight line on a local flat-earth
 * approximation. Over the tens of seconds this is ever asked to cover, a
 * great-circle track and a straight one differ by centimetres at these
 * latitudes, and the prediction error that actually matters is the
 * vessel turning -- which no projection can know about, and which the
 * next fix fixes.
 */

/** Metres per nautical mile. */
const METRES_PER_NM = 1852;

/** Metres per degree of latitude. Constant enough anywhere on Earth for a projection measured in seconds. */
const METRES_PER_DEGREE_LAT = 111_320;

/**
 * How far past a fix this will project.
 *
 * A position extrapolated for minutes is a guess dressed as data: a
 * vessel that has stopped transmitting may have turned, moored or landed.
 * Past this the glyph simply stays where it was last really seen, and the
 * layer's own age filter decides when to stop drawing it at all.
 */
export const MAX_PROJECTION_MS = 90_000;

export interface Velocity {
    /** Speed over ground, in knots. */
    speedKt: number;
    /** Course over ground (the direction of travel, not necessarily where the bow or nose points), in degrees clockwise from true north. */
    courseDeg: number;
}

export interface Position {
    lat: number;
    lng: number;
}

/**
 * `from` advanced along `velocity` for `elapsedMs`.
 *
 * Returns `from` unchanged for anything it cannot honestly project: a
 * stationary or unknown speed, a nonsense course, a negative elapsed time
 * (a fix stamped in the future, which upstreams do send), or a longitude
 * scale that collapses at the pole.
 */
export function projectPosition(from: Position, velocity: Velocity | null, elapsedMs: number): Position {
    if (!velocity) return from;
    const { speedKt, courseDeg } = velocity;
    if (!Number.isFinite(speedKt) || !Number.isFinite(courseDeg) || speedKt <= 0) return from;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return from;

    const metres = (Math.min(elapsedMs, MAX_PROJECTION_MS) / 3_600_000) * speedKt * METRES_PER_NM;
    const course = (courseDeg * Math.PI) / 180;

    const latitudeScale = Math.cos((from.lat * Math.PI) / 180);
    // Within ~0.5km of a pole a degree of longitude is nothing, and
    // dividing by it would fling the glyph off the map. Nothing this app
    // watches goes there; the guard is so that a corrupt fix cannot.
    if (latitudeScale < 1e-6) return from;

    return {
        lat: from.lat + (metres * Math.cos(course)) / METRES_PER_DEGREE_LAT,
        lng: from.lng + (metres * Math.sin(course)) / (METRES_PER_DEGREE_LAT * latitudeScale),
    };
}
