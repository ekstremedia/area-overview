/**
 * The position this device is looking at, and the query string that asks
 * the BFF about it.
 *
 * The rule is narrow on purpose: coordinates are sent **only when this
 * device has overridden `homeView`**. So the kiosk and every visitor who
 * has not pressed locate send byte-identical URLs, share one cache key,
 * one TTL and one ETag -- one upstream call for the whole internet -- and
 * nothing about the default path changed when this was added.
 *
 * It also makes "am I looking somewhere other than home?" a single
 * boolean the pages can key their captions off, rather than a comparison
 * against a default that would have to be kept in step with the schema.
 */
import { roundCoordinate } from './geolocation.js';
import { computed, type ReadonlySignal } from './core/signal.js';
import { localOverrides } from './settings/localOverrides.js';

export interface Position {
    lat: number;
    lng: number;
}

/** The overridden position, or `null` when this device follows the shared home view. */
export const activePosition: ReadonlySignal<Position | null> = computed(() => {
    const override = localOverrides.get().homeView;
    if (!override) return null;
    // Rounded again on the way out. The value stored by the locate control
    // is already rounded, but a `homeView` override can also be typed into
    // the settings page by hand at full precision -- and a position must
    // not leave this browser finer than the promise made in
    // `geolocation.ts`.
    return { lat: roundCoordinate(override.lat), lng: roundCoordinate(override.lng) };
});

/** `''` for the home position, or `'?lat=59.91&lng=10.75'`. Appended to a request path by the pages' fetchers. */
export function positionQuery(): string {
    const position = activePosition.get();
    if (!position) return '';
    return `?${new URLSearchParams({ lat: String(position.lat), lng: String(position.lng) }).toString()}`;
}
