/**
 * A hash-fragment router. Deliberately fragment-based (`#/cameras/front`)
 * rather than History-API path-based: the fragment never leaves the
 * browser, so it never reaches the reverse proxy's access log and needs
 * no server-side SPA-fallback rule for a page that doesn't exist as a
 * real path on this box.
 *
 * `Route` is a real discriminated union (not a loosely-typed string) so
 * that a `switch (route.name)` with no `default` -- or a `default` that
 * hands the leftover value to `assertNever` -- fails to compile the
 * moment a route is added here without being handled at every call site.
 */
import { signal, type ReadonlySignal } from './signal.js';

export type Route =
    { name: 'map' } | { name: 'weather' } | { name: 'aurora' } | { name: 'tide' } | { name: 'cameras'; cameraId?: string } | { name: 'settings' };

const DEFAULT_ROUTE: Route = { name: 'map' };

/** For a `default` branch of an exhaustive `switch (route.name)`: fails to compile unless `value` really is unreachable. */
export function assertNever(value: never): never {
    throw new Error(`unreachable route: ${JSON.stringify(value)}`);
}

/**
 * A camera id as a hash path segment, and back.
 *
 * `camera_id` is whatever the BFF's upstream calls the camera -- the
 * schema puts no shape on it -- so a value containing `/`, `#` or a
 * space would otherwise either split into two segments here or produce a
 * hash the browser rewrites. `decodeURIComponent` throws on a malformed
 * escape (a bare `%`), and a hash the visitor typed can be anything, so
 * the decode falls back to the raw segment rather than letting the
 * router throw.
 */
export function encodeCameraId(cameraId: string): string {
    return encodeURIComponent(cameraId);
}

function decodeCameraId(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

export function parseHash(hash: string): Route {
    const segments = hash
        .replace(/^#/, '')
        .split('/')
        .filter((segment) => segment.length > 0);
    const [head, second] = segments;
    switch (head) {
        case undefined:
        case 'map':
            return { name: 'map' };
        case 'weather':
            return { name: 'weather' };
        case 'aurora':
            return { name: 'aurora' };
        case 'tide':
            return { name: 'tide' };
        case 'settings':
            return { name: 'settings' };
        case 'cameras':
            return second === undefined ? { name: 'cameras' } : { name: 'cameras', cameraId: decodeCameraId(second) };
        default:
            return DEFAULT_ROUTE;
    }
}

const routeSignal = signal<Route>(parseHash(location.hash));

window.addEventListener('hashchange', () => {
    routeSignal.set(parseHash(location.hash));
});

/**
 * Navigates from inside the app, publishing the new route immediately
 * rather than waiting for the browser's own `hashchange` to come back
 * round.
 *
 * The hash is still the source of truth (the listener above republishes
 * an equal route a moment later, harmlessly); what this buys is that
 * anything reading `currentRoute` right after the call -- the auto-cycle
 * timer deciding which page comes next, chiefly -- sees the page that is
 * actually being shown. Only the shell's own programmatic navigation
 * needs this; a tab tap is a real user gesture and gets its `hashchange`
 * either way.
 */
export function navigateToRoute(route: Route): void {
    const hash = route.name === 'cameras' && route.cameraId !== undefined ? `#/cameras/${encodeCameraId(route.cameraId)}` : `#/${route.name}`;
    location.hash = hash;
    routeSignal.set(parseHash(hash));
}

export const currentRoute: ReadonlySignal<Route> = routeSignal;
