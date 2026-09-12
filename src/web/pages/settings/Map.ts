/**
 * Map section (artboard 07's "Kart"): the home view (`homeView.lat/lng/
 * zoom`) as three `NumberField`s, plus a "bruk kartets nåværende
 * posisjon"/"use the map's current position" button.
 *
 * `homeView` is a compound object, same shape as `Display.ts`'s `night`:
 * a local `draft` mirrors it so lat/lng/zoom always compose a full,
 * coherent write regardless of which field last changed, and the draft
 * is only re-synced from the store for a field that doesn't currently
 * have focus (see `Display.ts`'s doc comment for the full reasoning).
 *
 * The "use current position" button reads `activeMapInstance` --
 * `null` whenever the map page isn't currently mounted, which, under
 * this app's one-page-at-a-time routing, is always true while viewing
 * settings (the map is torn down before settings ever mounts). The
 * honest behavior is to disable the button rather than fabricate a
 * position; see `map/activeMap.ts`'s doc comment.
 */
import { HomeViewNumberSchema, type Settings } from '../../../shared/schemas/settings.js';
import { numberField, type NumberFieldHandle } from '../../components/NumberField.js';
import { effect } from '../../core/signal.js';
import { formatNumber, t } from '../../i18n/index.js';
import { activeMapInstance } from '../map/activeMap.js';
import { LOCATED_ZOOM, readCurrentView } from '../map/homeView.js';
import { requestPosition } from '../../geolocation.js';
import { setLocalOverride } from '../../settings/localOverrides.js';
import { field, overrideFor, type FieldHandle } from './field.js';
import type { SectionMount } from './sectionContext.js';

export const mount: SectionMount = (container, ctx) => {
    const root = document.createElement('div');
    root.className = 'settings-section-map';

    const { store } = ctx;
    const initial = store.settings.get();

    const draft: Settings['homeView'] = { ...initial.homeView };

    function writeHomeView(): ReturnType<typeof store.patchSettings> {
        return store.patchSettings({ homeView: { ...draft } });
    }

    const latField: NumberFieldHandle = numberField({
        value: draft.lat,
        schema: HomeViewNumberSchema.lat,
        step: '0.0001',
        id: 'settings-homeview-lat',
        write: (value) => {
            draft.lat = value;
            return writeHomeView();
        },
    });

    const lngField: NumberFieldHandle = numberField({
        value: draft.lng,
        schema: HomeViewNumberSchema.lng,
        step: '0.0001',
        id: 'settings-homeview-lng',
        write: (value) => {
            draft.lng = value;
            return writeHomeView();
        },
    });

    const zoomField: NumberFieldHandle = numberField({
        value: draft.zoom,
        schema: HomeViewNumberSchema.zoom,
        step: '1',
        id: 'settings-homeview-zoom',
        write: (value) => {
            draft.zoom = value;
            return writeHomeView();
        },
    });

    // Three inputs, one `homeView` object: the badge belongs to the row
    // that holds all three, not to each number.
    const coordinateRows: FieldHandle[] = [
        field({ label: t('settings.map.lat'), inputId: 'settings-homeview-lat', control: latField.el }),
        field({ label: t('settings.map.lng'), inputId: 'settings-homeview-lng', control: lngField.el }),
        field({ label: t('settings.map.zoom'), inputId: 'settings-homeview-zoom', control: zoomField.el }),
    ];
    const row = document.createElement('div');
    row.className = 'settings-homeview-row';
    row.append(...coordinateRows.map((one) => one.el));

    const useCurrentButton = document.createElement('button');
    useCurrentButton.type = 'button';
    useCurrentButton.className = 'settings-use-current-view';
    useCurrentButton.textContent = t('settings.map.useCurrentView');
    useCurrentButton.addEventListener('click', () => {
        const map = activeMapInstance.get();
        if (!map) return;
        const view = readCurrentView(map);
        draft.lat = view.lat;
        draft.lng = view.lng;
        draft.zoom = view.zoom;
        latField.update(view.lat);
        lngField.update(view.lng);
        zoomField.update(view.zoom);
        void writeHomeView();
    });

    // "Use my position" lives here as well as on the map, because the map
    // control is only reachable while the map page is open -- and the
    // settings page is where someone goes looking for it.
    const useMyPositionButton = document.createElement('button');
    useMyPositionButton.type = 'button';
    useMyPositionButton.className = 'settings-use-my-position';
    useMyPositionButton.textContent = t('settings.map.useMyPosition');

    const positionHint = document.createElement('div');
    positionHint.className = 'settings-use-current-view-hint';
    positionHint.hidden = true;

    useMyPositionButton.addEventListener('click', () => {
        useMyPositionButton.disabled = true;
        positionHint.textContent = t('map.locate.locating');
        positionHint.hidden = false;
        void requestPosition().then((outcome) => {
            useMyPositionButton.disabled = false;
            if (outcome.kind !== 'ok') {
                positionHint.textContent = t(outcome.kind === 'denied' ? 'map.locate.denied' : 'map.locate.unavailable');
                return;
            }
            positionHint.hidden = true;
            // Straight to the device's own overrides, never a shared
            // write -- see `MapPage.ts`'s locate control for why this is
            // the one deliberate exception to the usual routing.
            const next = { lat: outcome.lat, lng: outcome.lng, zoom: LOCATED_ZOOM };
            draft.lat = next.lat;
            draft.lng = next.lng;
            draft.zoom = next.zoom;
            latField.update(next.lat);
            lngField.update(next.lng);
            zoomField.update(next.zoom);
            setLocalOverride('homeView', next);
        });
    });

    const notMountedHint = document.createElement('div');
    notMountedHint.className = 'settings-use-current-view-hint';
    notMountedHint.textContent = t('settings.map.mapNotMounted');

    const homeViewRow = field({
        label: t('settings.map.homeView'),
        control: row,
        override: overrideFor(
            store,
            'homeView',
            (shared) => `${formatNumber(shared.lat)}, ${formatNumber(shared.lng)} \u00b7 ${t('settings.map.zoom')} ${formatNumber(shared.zoom)}`,
        ),
    });
    const rows: FieldHandle[] = [homeViewRow, ...coordinateRows];
    root.append(homeViewRow.el, useCurrentButton, notMountedHint, useMyPositionButton, positionHint);
    container.append(root);

    const disposeStoreEffect = effect(() => {
        const settings = store.settings.get();
        const latFocused = document.activeElement === latField.input;
        const lngFocused = document.activeElement === lngField.input;
        const zoomFocused = document.activeElement === zoomField.input;

        if (!latFocused) draft.lat = settings.homeView.lat;
        if (!lngFocused) draft.lng = settings.homeView.lng;
        if (!zoomFocused) draft.zoom = settings.homeView.zoom;

        latField.update(settings.homeView.lat, false);
        lngField.update(settings.homeView.lng, false);
        zoomField.update(settings.homeView.zoom, false);
    });

    const disposeMapEffect = effect(() => {
        const hasMap = activeMapInstance.get() !== null;
        useCurrentButton.disabled = !hasMap;
        notMountedHint.style.display = hasMap ? 'none' : '';
    });

    return function dispose(): void {
        disposeStoreEffect();
        disposeMapEffect();
        for (const one of rows) one.dispose();
        root.remove();
    };
};
