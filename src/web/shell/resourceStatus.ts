/**
 * Shared "own resource -> masthead freshness" wiring for every
 * independently-polling content page (weather, aurora, tide, cameras).
 * `ResourceState`'s `error` variant carries no `fetchedAt` for its
 * `lastData` (see `core/resource.ts`), so the last real fetch time has to
 * be remembered across a subsequent error -- this closes over exactly
 * that one piece of state so every page doesn't reimplement it.
 */
import type { ResourceState } from '../core/resource.js';
import type { PageStatus } from './page-status.js';

/**
 * Returns a `report` function a page calls with its resource's current
 * state on every reactive update. `pageFreshness` reflects the most
 * recent successful fetch, and stays populated (rather than reverting to
 * `null`) across a subsequent `error`, so the masthead's stale-banner
 * check keeps working while a page is showing stale data after a failed
 * poll.
 */
export function createFreshnessReporter(intervalMs: number, status: PageStatus): (state: ResourceState<unknown>) => void {
    let lastFetchedAt: Date | undefined;
    return function report(state: ResourceState<unknown>): void {
        if (state.status === 'ready') lastFetchedAt = state.fetchedAt;
        status.freshness(lastFetchedAt ? { fetchedAt: lastFetchedAt, intervalMs } : null);
    };
}
