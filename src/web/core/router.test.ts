import { describe, expect, it } from 'vitest';
import { assertNever, currentRoute, encodeCameraId, parseHash, type Route } from './router.js';

describe('parseHash', () => {
    it('parses the empty/root hash as the map route', () => {
        expect(parseHash('')).toEqual({ name: 'map' });
        expect(parseHash('#')).toEqual({ name: 'map' });
        expect(parseHash('#/')).toEqual({ name: 'map' });
        expect(parseHash('#/map')).toEqual({ name: 'map' });
    });

    it('parses simple single-segment routes', () => {
        expect(parseHash('#/weather')).toEqual({ name: 'weather' });
        expect(parseHash('#/aurora')).toEqual({ name: 'aurora' });
        expect(parseHash('#/tide')).toEqual({ name: 'tide' });
        expect(parseHash('#/settings')).toEqual({ name: 'settings' });
    });

    it('parses a bare cameras hash with no cameraId key at all', () => {
        const route = parseHash('#/cameras');
        expect(route).toEqual({ name: 'cameras' });
        expect('cameraId' in route).toBe(false);
    });

    it('parses a cameras hash with an id into cameraId', () => {
        expect(parseHash('#/cameras/front')).toEqual({ name: 'cameras', cameraId: 'front' });
    });

    it('round-trips a camera id that is not URL-safe', () => {
        // `camera_id` is whatever the upstream calls the camera, and the
        // schema puts no shape on it. An unescaped `/` would split into a
        // second path segment and the id would arrive truncated.
        const cameraId = 'nord/vest kamera';
        expect(parseHash(`#/cameras/${encodeCameraId(cameraId)}`)).toEqual({ name: 'cameras', cameraId });
    });

    it('keeps a malformed escape as-is rather than throwing on it', () => {
        // Anyone can type a hash. `decodeURIComponent('%')` throws, and a
        // router that throws takes the whole app down with it.
        expect(() => parseHash('#/cameras/%')).not.toThrow();
        expect(parseHash('#/cameras/%')).toEqual({ name: 'cameras', cameraId: '%' });
    });

    it('resolves an unknown/malformed hash to the map route without throwing', () => {
        expect(() => parseHash('#/nonsense')).not.toThrow();
        expect(parseHash('#/nonsense')).toEqual({ name: 'map' });
        expect(parseHash('#garbage//not-a-route')).toEqual({ name: 'map' });
    });
});

/**
 * happy-dom's `location.hash` setter doesn't itself dispatch `hashchange` in the vitest
 * test environment (real browsers do), so tests trigger it explicitly -- this is a test
 * environment gap, not something `router.ts` needs to work around for real usage.
 */
function navigate(hash: string): void {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
}

describe('currentRoute', () => {
    it('is a readonly signal that updates on hashchange', () => {
        navigate('#/weather');
        expect(currentRoute.get()).toEqual({ name: 'weather' });

        navigate('#/cameras/back');
        expect(currentRoute.get()).toEqual({ name: 'cameras', cameraId: 'back' });

        navigate('#/bogus');
        expect(currentRoute.get()).toEqual({ name: 'map' });
    });
});

// Exhaustiveness demonstration/compile-check: this switch has no `default` case that
// silently swallows an unhandled route. If a 7th `Route` member is ever added without a
// matching `case` here, `route` in the `default` branch stops being `never`, and passing
// it to `assertNever` fails to compile -- `npm run typecheck` catches the missing case,
// not a runtime test.
function describeRoute(route: Route): string {
    switch (route.name) {
        case 'map':
            return 'Map';
        case 'weather':
            return 'Weather';
        case 'aurora':
            return 'Aurora';
        case 'tide':
            return 'Tide';
        case 'cameras':
            return route.cameraId === undefined ? 'Cameras' : `Camera: ${route.cameraId}`;
        case 'settings':
            return 'Settings';
        default:
            return assertNever(route);
    }
}

describe('Route exhaustiveness', () => {
    it('describeRoute handles every route name', () => {
        expect(describeRoute({ name: 'map' })).toBe('Map');
        expect(describeRoute({ name: 'cameras', cameraId: 'front' })).toBe('Camera: front');
        expect(describeRoute({ name: 'cameras' })).toBe('Cameras');
    });
});
