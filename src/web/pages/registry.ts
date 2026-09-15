/**
 * Maps every `Route` to the page module that renders it, plus the i18n
 * keys the masthead needs for that route's tab label and locality
 * caption. Both `AppShell.ts` (mounting/disposing pages) and
 * `Masthead.ts` (tabs, locality) read from this one place so route
 * metadata can't drift between the two.
 */
import { assertNever, currentRoute, type Route } from '../core/router.js';
import type { ParamlessKey } from '../i18n/index.js';
import type { PageId } from '../../shared/schemas/settings.js';
import { CAMERAS_DORMANT } from './cameras/dormancy.js';
import * as AuroraPage from './AuroraPage.js';
import * as CamerasPage from './CamerasPage.js';
import * as CameraViewerPage from './CameraViewerPage.js';
import * as MapPage from './MapPage.js';
import * as SettingsPage from './SettingsPage.js';
import * as TidePage from './TidePage.js';
import * as WeatherPage from './WeatherPage.js';

/**
 * The `cameras` route carries an optional `cameraId` (`#/cameras/<id>`
 * vs. plain `#/cameras`), but `PageEntry.render` takes only a container --
 * every route's tab/entry is registered once, statically, at module load.
 * Rather than threading route params through that whole contract for one
 * route, this single entry reads `currentRoute` itself at render time
 * (called from within `AppShell.ts`'s own route effect, so this read is
 * still tracked by that same effect) and dispatches to the grid or the
 * full-screen viewer accordingly.
 */
function renderCameras(container: HTMLElement): () => void {
    const route = currentRoute.get();
    const cameraId = route.name === 'cameras' ? route.cameraId : undefined;
    return cameraId ? CameraViewerPage.render(container, cameraId) : CamerasPage.render(container);
}

export interface PageEntry {
    name: Route['name'];
    navKey: ParamlessKey;
    localityKey: ParamlessKey;
    render: (container: HTMLElement) => () => void;
}

/**
 * The masthead's tab row filters against `settings.enabledPages`
 * (`PageId[]`, which excludes `settings`) -- `name` here is narrowed to
 * `PageId` specifically (not the broader `Route['name']` every
 * `PageEntry` carries) so that filter check type-checks without a cast.
 */
export interface TabPageEntry extends PageEntry {
    name: PageId;
}

/**
 * The cameras entry, kept separate from `NAV_PAGES` below because it is
 * two different things at once while the cameras are dormant
 * (`cameras/dormancy.ts`): it must **not** appear as a tab, and it must
 * still be **registered as a route**, so an old `#/cameras/<id>`
 * bookmark on the kiosk resolves to the viewer instead of silently
 * falling back to the map.
 */
const CAMERAS_PAGE: TabPageEntry = { name: 'cameras', navKey: 'nav.cameras', localityKey: 'locality.cameras', render: renderCameras };

/** The masthead's tab row, in display order -- Settings is a separate link, not a tab (see `SettingsPage.ts`'s doc comment). Four entries while the cameras are dormant, five when the flag is flipped back. */
export const NAV_PAGES: readonly TabPageEntry[] = [
    { name: 'map', navKey: 'nav.map', localityKey: 'locality.map', render: MapPage.render },
    { name: 'weather', navKey: 'nav.weather', localityKey: 'locality.weather', render: WeatherPage.render },
    { name: 'aurora', navKey: 'nav.aurora', localityKey: 'locality.aurora', render: AuroraPage.render },
    { name: 'tide', navKey: 'nav.tide', localityKey: 'locality.tide', render: TidePage.render },
    ...(CAMERAS_DORMANT ? [] : [CAMERAS_PAGE]),
];

export const SETTINGS_PAGE: PageEntry = {
    name: 'settings',
    navKey: 'nav.settings',
    localityKey: 'locality.settings',
    render: SettingsPage.render,
};

/** Every route, tab or not -- `CAMERAS_PAGE` is in here unconditionally (see its doc comment), which is what keeps `#/cameras/<id>` resolving while the tab is gone. */
const PAGES_BY_ROUTE_NAME: ReadonlyMap<Route['name'], PageEntry> = new Map(
    [...NAV_PAGES, CAMERAS_PAGE, SETTINGS_PAGE].map((page) => [page.name, page]),
);

export function pageForRoute(route: Route): PageEntry {
    switch (route.name) {
        case 'map':
        case 'weather':
        case 'aurora':
        case 'tide':
        case 'cameras':
        case 'settings': {
            const page = PAGES_BY_ROUTE_NAME.get(route.name);
            if (!page) throw new Error(`no page registered for route: ${route.name}`);
            return page;
        }
        default:
            return assertNever(route);
    }
}
