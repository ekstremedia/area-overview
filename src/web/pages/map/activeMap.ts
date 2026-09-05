/**
 * A module-scope handle to the map page's own Leaflet instance, if the
 * map page is currently mounted -- `null` otherwise. `MapPage.ts` sets
 * this once its Leaflet instance is ready and clears it on unmount.
 *
 * Exists for the settings page's "use the map's current position" button
 * (`settings/Map.ts`), which needs `readCurrentView(map)` (Phase 6).
 * Under this app's routing (`AppShell.ts` always disposes the previous
 * page before mounting the next), the map page is torn down -- and this
 * signal cleared to `null` -- *before* the settings page ever mounts, so
 * in practice that button is always disabled while viewing settings. That
 * is the honest, correct behavior given the architecture (no live map
 * instance ever coexists with the settings page), not a bug: see
 * `settings/Map.ts`'s own doc comment for why the button is
 * disabled/hidden rather than faking a value.
 */
import type * as Leaflet from 'leaflet';
import { signal, type Signal } from '../../core/signal.js';

export const activeMapInstance: Signal<Leaflet.Map | null> = signal(null);
