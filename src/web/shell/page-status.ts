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

/** Bumped by every `claimPageStatus()`. A slot remembers which claim last wrote it, which is what tells a releasing page whose value it is looking at. */
let statusGeneration = 0;

interface StatusSlot<T> {
    signal: Signal<T | null>;
    /** A write from `claim`. Ignored once a later page has claimed: during a slide the outgoing page is still polling, and its answers are no longer the ones on screen. */
    write: (claim: number, value: T | null) => void;
    /** Clears the slot for a releasing claim, unless a later-mounted page has since written its own value here. */
    releaseFor: (claim: number) => void;
}

/**
 * One shared slot: an ordinary signal for readers, plus the bookkeeping
 * that says which claim's value it currently holds.
 *
 * `signal.set` stays writable -- tests set these up directly, and the
 * masthead/footer only ever read -- but a page writes through its claim,
 * which is what makes the two rules above enforceable.
 */
function statusSlot<T>(): StatusSlot<T> {
    const inner = signal<T | null>(null);
    let writtenAt = 0;

    function set(next: T | null): void {
        writtenAt = statusGeneration;
        inner.set(next);
    }

    return {
        signal: {
            get: (): T | null => inner.get(),
            set,
            update: (fn): void => {
                set(fn(inner.get()));
            },
        },
        write: (claim, value): void => {
            if (claim !== statusGeneration) return; // a later page is the live one now
            set(value);
        },
        releaseFor: (claim): void => {
            if (writtenAt > claim) return; // a later page owns this slot now
            writtenAt = 0;
            inner.set(null);
        },
    };
}

const freshnessSlot = statusSlot<Freshness>();
const attributionSlot = statusSlot<string>();
const layerCountsSlot = statusSlot<LayerCounts>();
const layerListingSlot = statusSlot<LiveLayerListing>();
const layerColorsSlot = statusSlot<LiveLayerColors>();
const accountStatusSlot = statusSlot<AccountStatus>();

const ALL_SLOTS = [freshnessSlot, attributionSlot, layerCountsSlot, layerListingSlot, layerColorsSlot, accountStatusSlot];

export const pageFreshness: Signal<Freshness | null> = freshnessSlot.signal;

export const pageAttribution: Signal<string | null> = attributionSlot.signal;

/** One mounted page's handle on the shared status slots. Every page holds exactly one, from `render()` to its dispose. */
export interface PageStatus {
    /** The page's data freshness, for the masthead's stale banner. */
    freshness: (value: Freshness | null) => void;
    /** The footer's credit line. Licence-required for most of this app's upstreams, so it must never name the wrong source. */
    attribution: (value: string | null) => void;
    /** The masthead's live counts, one per group (map only). */
    layerCounts: (value: LayerCounts | null) => void;
    /** What those counts open when tapped (map only). */
    layerListing: (value: LiveLayerListing | null) => void;
    /**
     * Each group's own "worst active colour", one per group that reports
     * one at all (map only) -- currently only `warnings`
     * (`LiveLayerCallbacks.reportColor` in `pages/map/liveLayerMount.ts`).
     * Consumed by the warnings chip's tint in `Masthead.ts` (Phase H),
     * which needed no plumbing of its own thanks to this slot -- it gets
     * the same claim/release-per-slide safety every other slot on this
     * page does.
     */
    layerColors: (value: LiveLayerColors | null) => void;
    /** The masthead's login line (settings only). */
    accountStatus: (value: AccountStatus | null) => void;
    /** Gives the slots back on dispose. */
    release: () => void;
}

/**
 * Claims the shared status slots for one mounted page.
 *
 * The shell mounts the incoming page while the outgoing one is still on
 * screen (`AppShell.ts`'s slide), so for a few hundred milliseconds two
 * pages are alive at once, each with its own polling. Two rules fall out
 * of that, and both were bugs before they were rules:
 *
 * - Only the newest claim may write. The map page kept reporting vessel
 *   counts through the slide, so the masthead was still showing "22 skip"
 *   on the cameras page, with no map behind it and nothing left to
 *   correct the figure.
 * - A release clears a slot only if no newer page has written to it. The
 *   outgoing page is disposed *after* the incoming one has published, so
 *   an unconditional clear wiped its successor's: the footer's credit
 *   line went blank the instant every transition finished, and the page
 *   above it visibly grew into the freed line. Per slot, not
 *   all-or-nothing -- the cameras page publishes no attribution at all,
 *   and must still arrive to an empty footer rather than inherit the
 *   aurora page's.
 */
export function claimPageStatus(): PageStatus {
    statusGeneration += 1;
    const claimed = statusGeneration;
    return {
        freshness: (value) => {
            freshnessSlot.write(claimed, value);
        },
        attribution: (value) => {
            attributionSlot.write(claimed, value);
        },
        layerCounts: (value) => {
            layerCountsSlot.write(claimed, value);
        },
        layerListing: (value) => {
            layerListingSlot.write(claimed, value);
        },
        layerColors: (value) => {
            layerColorsSlot.write(claimed, value);
        },
        accountStatus: (value) => {
            accountStatusSlot.write(claimed, value);
        },
        release: () => {
            for (const slot of ALL_SLOTS) slot.releaseFor(claimed);
        },
    };
}

/**
 * The masthead's countable groups, in the order they are shown.
 *
 * A *group* is not a layer. The Veg layer (`shared/layers.ts`'s
 * `ROADS_LAYER`) is one layer with one toggle, but it puts two quite
 * different things on the map -- road notices and road cameras -- and
 * across the room "3 vegmeldinger" and "19 vegkamera" answer different
 * questions. So the masthead counts groups, and `shared/layers.ts`'s
 * `LiveLayerId` and this union are deliberately not the same list.
 *
 * This array is the single enumeration: `LayerCounts`, the listing, and
 * the masthead's own registry of colours and glyphs are all keyed off
 * it, so a fifth group is an entry here plus an entry in `Masthead.ts`'s
 * `COUNT_GROUPS` -- not another branch in a ternary. Both halves are the
 * compiler's business, not a comment's: `LayerCounts` and the listing
 * are `Record<LiveLayerGroupId, ...>`, and `COUNT_GROUPS` is keyed the
 * same way, so forgetting either one fails the build rather than
 * silently showing no count. (It was a hand-written `{ships, aircraft}`
 * pair until the fourth group arrived, which is exactly when that
 * stopped paying for itself.)
 */
export const LIVE_LAYER_GROUP_IDS = ['ships', 'aircraft', 'roadSituations', 'roadCameras', 'transit', 'warnings', 'species'] as const;

export type LiveLayerGroupId = (typeof LIVE_LAYER_GROUP_IDS)[number];

export type LayerCounts = Record<LiveLayerGroupId, number> & {
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
     *
     * Not per group: neither road group has an age filter at all (a road
     * notice is valid until it expires, never stale), so both contribute
     * a permanent zero. `transit` contributes a permanent zero too, for a
     * different reason -- its age filter runs server-side
     * (`transit.ts`'s own header comment), so a fix dropped for being
     * stale never reaches the client to be counted here at all. `warnings`
     * is the same as the road groups: a warning is valid until it expires,
     * not until it goes stale (`WARNINGS_LAYER`'s own doc comment).
     * `species` contributes a permanent zero too: a sighting is already
     * weeks old by the time GBIF publishes it, so "hidden for being stale"
     * has no meaning here either (`SPECIES_LAYER`'s own doc comment) --
     * `settings.species.animalsOnly` filters what is *counted*, not what
     * is hidden for age.
     */
    hiddenByAge: number;
};

/** Every group at zero -- what the map page publishes before any layer has answered. */
export function emptyLayerCounts(): LayerCounts {
    return { ships: 0, aircraft: 0, roadSituations: 0, roadCameras: 0, transit: 0, warnings: 0, species: 0, hiddenByAge: 0 };
}

export const liveLayerCounts: Signal<LayerCounts | null> = layerCountsSlot.signal;

/**
 * A group's own "worst active colour" (see `PageStatus.layerColors`'s doc
 * comment) -- a partial record, since most groups never call
 * `reportColor` at all and an absent key must mean exactly that, not "no
 * colour right now" (which is a real, distinct state: `null`).
 */
export type LiveLayerColors = Partial<Record<LiveLayerGroupId, string | null>>;

export const liveLayerColors: Signal<LiveLayerColors | null> = layerColorsSlot.signal;

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
    /**
     * What tapping this row should do, when panning the map to it is not
     * the right answer. Set only by road cameras: a camera *is* a
     * picture, so its row opens the picture, where panning to its pin
     * would leave the visitor to find and tap the pin themselves.
     *
     * Carried per item rather than per group so the shell stays
     * layer-agnostic -- it runs whatever the map page handed it and never
     * learns that a camera modal exists.
     */
    activate?: () => void;
}

export interface LiveLayerListing {
    /**
     * What each group currently has on the map, keyed by group id --
     * every group present, empty array when a layer is switched off, so
     * the masthead can index straight in without asking whether a key
     * exists.
     */
    items: Record<LiveLayerGroupId, LiveLayerItem[]>;
    /**
     * Pans and zooms the map to one item. Supplied by the map page (the
     * only thing holding a Leaflet instance) rather than reached for
     * through `activeMapInstance`, so the shell never touches Leaflet and
     * the listing is inert on any page that doesn't provide one.
     *
     * The default action for a row; an item carrying its own `activate`
     * overrides it.
     */
    focus: (item: LiveLayerItem) => void;
}

/**
 * What the masthead's counts open when tapped. `null` on every page but
 * the map, which is also what keeps the counts inert there.
 */
export const liveLayerListing: Signal<LiveLayerListing | null> = layerListingSlot.signal;

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

export const pageAccountStatus: Signal<AccountStatus | null> = accountStatusSlot.signal;
