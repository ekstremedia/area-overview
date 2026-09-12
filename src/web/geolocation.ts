/**
 * The visitor's own position, for the map's locate control and the
 * settings page's "use my position" row.
 *
 * Two properties this module exists to guarantee:
 *
 * - **It never throws and never rejects.** Every failure the Geolocation
 *   API can produce -- a refused permission, no fix available, a prompt
 *   nobody answers, an API that isn't there at all -- comes back as a
 *   tagged outcome the caller renders. A locate button is a convenience,
 *   and a convenience must not be able to break the page it sits on.
 * - **Coordinates are rounded before they leave.** `requestPosition`
 *   returns already-rounded values, so no call site can leak a precise
 *   one even by accident. There is no exported path to the raw fix.
 */

export type GeolocationOutcome =
    | { kind: 'ok'; lat: number; lng: number; accuracyM: number }
    | { kind: 'denied' }
    | { kind: 'unavailable' }
    | { kind: 'timeout' }
    | { kind: 'unsupported' };

/**
 * Two decimals: about 1.1 km of latitude, and ~400 m of longitude at
 * 69°N. Enough to pick a point forecast and the nearest tide station,
 * deliberately far too coarse to identify a house.
 *
 * This is the only precision the rest of the app ever sees. It is also
 * what the BFF rounds to server-side (`layers/point.ts`), so a visitor's
 * position is coarse in the browser, coarse in the query string, and
 * coarse in the cache key -- and is never persisted server-side at all.
 */
export const POSITION_PRECISION_DECIMALS = 2;

export function roundCoordinate(value: number): number {
    const factor = 10 ** POSITION_PRECISION_DECIMALS;
    return Math.round(value * factor) / factor;
}

export interface RequestPositionOptions {
    /** How long to wait for a fix before giving up. Also covers a permission prompt nobody answers, which is the likely case on a kiosk. */
    timeoutMs?: number;
    /** A cached fix this old or newer is acceptable, so pressing the button twice in a minute costs nothing. */
    maximumAgeMs?: number;
    /**
     * A fix vaguer than this is reported `unavailable` rather than used.
     *
     * A Raspberry Pi with no GPS answers from Wi-Fi and IP geolocation,
     * which can be tens of kilometres out and occasionally names a
     * different part of the country entirely. Silently moving the wall
     * display to a town nobody chose is worse than not moving it, so a
     * fix that vague is treated as no fix.
     */
    maxAccuracyM?: number;
    /** Injected by tests. Production reads `navigator.geolocation`. */
    geolocation?: Geolocation;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_ACCURACY_M = 50_000;

function outcomeForError(error: GeolocationPositionError): GeolocationOutcome {
    // Compared against the error's own constants rather than bare numbers:
    // the values are fixed by the spec, but the names say why.
    switch (error.code) {
        case error.PERMISSION_DENIED:
            return { kind: 'denied' };
        case error.TIMEOUT:
            return { kind: 'timeout' };
        default:
            return { kind: 'unavailable' };
    }
}

/** Asks the browser where it is. Resolves an outcome; never rejects. */
export function requestPosition(options: RequestPositionOptions = {}): Promise<GeolocationOutcome> {
    const geolocation = options.geolocation ?? (typeof navigator === 'undefined' ? undefined : navigator.geolocation);
    // Absent on an insecure origin, and on browsers with the API disabled
    // outright. Distinguished from `denied` so the UI can say "not
    // available here" rather than blaming a permission nobody was asked
    // for.
    if (!geolocation) return Promise.resolve({ kind: 'unsupported' });

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maximumAgeMs = options.maximumAgeMs ?? DEFAULT_MAXIMUM_AGE_MS;
    const maxAccuracyM = options.maxAccuracyM ?? DEFAULT_MAX_ACCURACY_M;

    return new Promise<GeolocationOutcome>((resolve) => {
        // Guards against a `geolocation` implementation that calls neither
        // callback -- which is exactly what an unanswered permission
        // prompt looks like in some browsers, despite the `timeout`
        // option below.
        const timer = setTimeout(() => {
            settle({ kind: 'timeout' });
        }, timeoutMs);

        let settled = false;
        function settle(outcome: GeolocationOutcome): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
        }

        try {
            geolocation.getCurrentPosition(
                (position) => {
                    if (position.coords.accuracy > maxAccuracyM) {
                        settle({ kind: 'unavailable' });
                        return;
                    }
                    settle({
                        kind: 'ok',
                        lat: roundCoordinate(position.coords.latitude),
                        lng: roundCoordinate(position.coords.longitude),
                        accuracyM: position.coords.accuracy,
                    });
                },
                (error) => {
                    settle(outcomeForError(error));
                },
                { timeout: timeoutMs, maximumAge: maximumAgeMs, enableHighAccuracy: false },
            );
        } catch {
            // `getCurrentPosition` is not specified to throw, but a
            // permissions-policy violation has been observed to. Nothing
            // about a locate button justifies an unhandled exception.
            settle({ kind: 'unavailable' });
        }
    });
}
