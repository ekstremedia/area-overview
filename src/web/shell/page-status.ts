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

export interface LayerCounts {
    ships: number;
    aircraft: number;
    /**
     * How many ships/aircraft the BFF returned but the map is not drawing
     * because their last position fix is older than the layer's
     * `maxAgeMinutes` -- summed across layers, since the masthead shows one
     * line for both.
     *
     * Surfaced deliberately rather than left implicit: upstream keeps
     * serving vessels whose fix is hours old (a moored boat that stopped
     * transmitting was observed at 310 minutes), and dropping them without
     * a word makes a boat someone was watching vanish for no visible
     * reason. Zooming makes it worse, since a zoom re-runs the age filter
     * and so is often the moment a just-expired vessel blinks out.
     */
    hiddenByAge: number;
}

export const liveLayerCounts: Signal<LayerCounts | null> = signal(null);

/**
 * One entry in the masthead's tap-through list of what is currently on
 * the map. Deliberately flat and layer-agnostic -- a name, a line of
 * detail, and a position -- so the shell can render ships and aircraft
 * with one component and needs to know nothing about AIS or ADS-B.
 */
export interface LiveLayerItem {
    id: string;
    /** Ship name or aircraft callsign, already falling back to something readable when the broadcast has none. */
    label: string;
    /** A short second line: speed for a ship, altitude for an aircraft. */
    detail: string;
    lat: number;
    lng: number;
}

export interface LiveLayerListing {
    ships: LiveLayerItem[];
    aircraft: LiveLayerItem[];
    /**
     * Pans and zooms the map to one item. Supplied by the map page (the
     * only thing holding a Leaflet instance) rather than reached for
     * through `activeMapInstance`, so the shell never touches Leaflet and
     * the listing is inert on any page that doesn't provide one.
     */
    focus: (item: LiveLayerItem) => void;
}

/**
 * What the masthead's counts open when tapped. `null` on every page but
 * the map, which is also what keeps the counts inert there.
 */
export const liveLayerListing: Signal<LiveLayerListing | null> = signal(null);

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
