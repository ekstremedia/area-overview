/**
 * Shared, page-supplied status the masthead and footer read from: the
 * active page's data freshness (for the stale banner and "Updated ...
 * ago"), its attribution text, (map only) live layer counts, and
 * (settings only) the account line. Each stays at its "nothing to
 * report" default of `null` until the mounted page publishes something,
 * which the masthead/footer render as hidden rather than fabricating a
 * placeholder.
 *
 * A page claims these slots on mount and gives them back on dispose
 * (`claimPageStatus`) -- which is more than bookkeeping, because two
 * pages are alive at once during the shell's slide transition.
 */
import { signal, type Signal } from '../core/signal.js';
import type { Freshness } from './staleness.js';

export const pageFreshness: Signal<Freshness | null> = signal(null);

export const pageAttribution: Signal<string | null> = signal(null);

/** Bumped by every `claimPageStatus()`; a claim clears the slots on release only while it still holds the newest number. */
let statusGeneration = 0;

/**
 * Claims the shared status slots for one mounted page, and returns the
 * function that gives them back.
 *
 * The shell mounts the incoming page while the outgoing one is still on
 * screen (`AppShell.ts`'s slide), so for a few hundred milliseconds two
 * pages are alive at once and the outgoing one is disposed *after* the
 * incoming one has already published its own attribution and freshness.
 * A page that cleared these slots unconditionally on dispose would
 * therefore wipe its successor's: the footer's attribution line went
 * blank at the end of every transition -- visibly, since the footer loses
 * a line and the page above it grows to fill the gap.
 *
 * So the release is conditional: clearing only happens while this claim
 * is still the newest one. A page mounted and disposed on its own (every
 * unit test, and any navigation that isn't a slide) clears exactly as
 * before.
 *
 * Not a guard on *writes*, only on the clear-on-unmount: an outgoing
 * page's own poll landing inside that same window can still publish over
 * its successor's line, which self-corrects on the incoming page's next
 * poll. The unconditional clear could not self-correct, because nothing
 * would write again until then.
 */
export function claimPageStatus(): () => void {
    statusGeneration += 1;
    const claimed = statusGeneration;
    return function release(): void {
        if (statusGeneration !== claimed) return; // another page has taken the slots over; they are its business now
        pageFreshness.set(null);
        pageAttribution.set(null);
        liveLayerCounts.set(null);
        liveLayerListing.set(null);
        pageAccountStatus.set(null);
    };
}

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
