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
}

export const liveLayerCounts: Signal<LayerCounts | null> = signal(null);
