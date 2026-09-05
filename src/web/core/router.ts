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
            return second === undefined ? { name: 'cameras' } : { name: 'cameras', cameraId: second };
        default:
            return DEFAULT_ROUTE;
    }
}

const routeSignal = signal<Route>(parseHash(location.hash));

window.addEventListener('hashchange', () => {
    routeSignal.set(parseHash(location.hash));
});

export const currentRoute: ReadonlySignal<Route> = routeSignal;
