/**
 * Shared, page-supplied status the masthead and footer read from: the
 * active page's data freshness (for the stale banner and "Updated ...
 * ago"), its attribution text, and (map only) live layer counts. No page
 * has real data yet (Phase 6+), so nothing calls `.set(...)` on any of
 * these in this phase -- every one stays at its "nothing to report"
 * default, which the masthead/footer render as hidden/placeholder rather
 * than fabricating data to demo the mechanism.
 */
import { signal, type Signal } from '../core/signal.js';
import type { Freshness } from './staleness.js';

export const pageFreshness: Signal<Freshness | null> = signal(null);

export const pageAttribution: Signal<string | null> = signal(null);

/**
 * A page-supplied override for the masthead's locality caption, for the
 * one route (cameras) whose caption depends on live data (the camera
 * count) rather than the static per-route text `registry.ts`'s
 * `localityKey` already covers. `null` (the default) means "use the
 * static `localityKey` text" -- every route but cameras leaves this alone.
 */
export const pageLocalityOverride: Signal<string | null> = signal(null);

export interface LayerCounts {
    ships: number;
    aircraft: number;
}

export const liveLayerCounts: Signal<LayerCounts | null> = signal(null);

/**
 * The settings page's login/logout status line, rendered in the
 * masthead's status area next to the Settings link (same extension-point
 * pattern as `liveLayerCounts`) -- `null` (the default) means "not on the
 * settings page, or not logged in", in which case nothing renders. Only
 * `SettingsPage.ts` ever calls `.set(...)` on this.
 */
export interface AccountStatus {
    text: string;
    logoutLabel: string;
    onLogout: () => void;
}

export const pageAccountStatus: Signal<AccountStatus | null> = signal(null);
