import { describe, expect, it, vi } from 'vitest';
import { requestPosition, roundCoordinate } from './geolocation.js';

/** The three error codes, as the spec fixes them -- a real `GeolocationPositionError` carries them as instance constants. */
function geolocationError(code: 1 | 2 | 3): GeolocationPositionError {
    return { code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

function fixAt(latitude: number, longitude: number, accuracy = 20): GeolocationPosition {
    return { coords: { latitude, longitude, accuracy }, timestamp: Date.now() } as GeolocationPosition;
}

/** A `Geolocation` that answers however the test says. */
function fakeGeolocation(behaviour: (success: PositionCallback, failure: PositionErrorCallback) => void): Geolocation {
    return {
        getCurrentPosition: vi.fn((success: PositionCallback, failure?: PositionErrorCallback | null) => {
            behaviour(success, failure ?? (() => undefined));
        }),
        watchPosition: vi.fn(() => 0),
        clearWatch: vi.fn(),
    };
}

describe('roundCoordinate', () => {
    it('rounds to two decimals -- about a kilometre, deliberately too coarse to find a house', () => {
        expect(roundCoordinate(59.913_869)).toBe(59.91);
        expect(roundCoordinate(10.752_245)).toBe(10.75);
    });

    it('rounds negatives the same way', () => {
        expect(roundCoordinate(-3.704_2)).toBe(-3.7);
    });
});

describe('requestPosition', () => {
    it('returns a position already rounded, so no call site can leak a precise one', async () => {
        const geolocation = fakeGeolocation((success) => {
            success(fixAt(59.913_869, 10.752_245));
        });

        const outcome = await requestPosition({ geolocation });

        expect(outcome).toEqual({ kind: 'ok', lat: 59.91, lng: 10.75, accuracyM: 20 });
    });

    it('reports a refused permission as denied, which the UI can explain', async () => {
        const geolocation = fakeGeolocation((_success, failure) => {
            failure(geolocationError(1));
        });

        expect(await requestPosition({ geolocation })).toEqual({ kind: 'denied' });
    });

    it('reports no fix as unavailable', async () => {
        const geolocation = fakeGeolocation((_success, failure) => {
            failure(geolocationError(2));
        });

        expect(await requestPosition({ geolocation })).toEqual({ kind: 'unavailable' });
    });

    it("reports the browser's own timeout as a timeout", async () => {
        const geolocation = fakeGeolocation((_success, failure) => {
            failure(geolocationError(3));
        });

        expect(await requestPosition({ geolocation })).toEqual({ kind: 'timeout' });
    });

    it('gives up on an implementation that calls neither callback -- an unanswered permission prompt', async () => {
        vi.useFakeTimers();
        const geolocation = fakeGeolocation(() => {
            // Deliberately silent.
        });

        const pending = requestPosition({ geolocation, timeoutMs: 10_000 });
        await vi.advanceTimersByTimeAsync(10_000);

        expect(await pending).toEqual({ kind: 'timeout' });
        vi.useRealTimers();
    });

    it('refuses a fix too vague to be worth moving the map for', async () => {
        // What a Raspberry Pi with no GPS reports: a Wi-Fi/IP-derived fix
        // tens of kilometres out. Silently moving the wall display to a
        // town nobody chose is worse than not moving it.
        const geolocation = fakeGeolocation((success) => {
            success(fixAt(68.7, 15.4, 80_000));
        });

        expect(await requestPosition({ geolocation })).toEqual({ kind: 'unavailable' });
    });

    it('accepts a fix inside the accuracy bound', async () => {
        const geolocation = fakeGeolocation((success) => {
            success(fixAt(68.7, 15.4, 49_000));
        });

        expect((await requestPosition({ geolocation, maxAccuracyM: 50_000 })).kind).toBe('ok');
    });

    it('reports an absent API as unsupported, not as a refused permission', async () => {
        // Distinguished so the UI can say "not available here" rather than
        // blaming a permission nobody was ever asked for.
        expect(await requestPosition({ geolocation: undefined as unknown as Geolocation })).toEqual({ kind: 'unsupported' });
    });

    it('never rejects, even when the API throws outright', async () => {
        const geolocation = {
            getCurrentPosition: () => {
                throw new Error('permissions policy violation');
            },
        } as unknown as Geolocation;

        await expect(requestPosition({ geolocation })).resolves.toEqual({ kind: 'unavailable' });
    });

    it('settles once, even if the implementation calls back after the timeout', async () => {
        vi.useFakeTimers();
        let late: PositionCallback | undefined;
        const geolocation = fakeGeolocation((success) => {
            late = success;
        });

        const pending = requestPosition({ geolocation, timeoutMs: 1000 });
        await vi.advanceTimersByTimeAsync(1000);
        late?.(fixAt(59.91, 10.75));

        expect(await pending).toEqual({ kind: 'timeout' });
        vi.useRealTimers();
    });
});
