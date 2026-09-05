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
import { t } from '../../i18n/index.js';
import { activeMapInstance } from '../map/activeMap.js';
import { readCurrentView } from '../map/homeView.js';
import type { SectionMount } from './sectionContext.js';

function field(labelText: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-field';
    const label = document.createElement('div');
    label.className = 'settings-field-label';
    label.textContent = labelText;
    row.append(label, control);
    return row;
}

export const mount: SectionMount = (container, ctx) => {
    const root = document.createElement('div');
    root.className = 'settings-section-map';

    const { store } = ctx;
    const loggedIn = ctx.loggedIn;
    const initial = store.settings.get();

    const draft: Settings['homeView'] = { ...initial.homeView };

    function writeHomeView(): ReturnType<typeof store.patchSettings> {
        return store.patchSettings({ homeView: { ...draft } });
    }

    const latField: NumberFieldHandle = numberField({
        value: draft.lat,
        schema: HomeViewNumberSchema.lat,
        step: '0.0001',
        disabled: !loggedIn,
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
        disabled: !loggedIn,
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
        disabled: !loggedIn,
        id: 'settings-homeview-zoom',
        write: (value) => {
            draft.zoom = value;
            return writeHomeView();
        },
    });

    const row = document.createElement('div');
    row.className = 'settings-homeview-row';
    row.append(field(t('settings.map.lat'), latField.el), field(t('settings.map.lng'), lngField.el), field(t('settings.map.zoom'), zoomField.el));

    const useCurrentButton = document.createElement('button');
    useCurrentButton.type = 'button';
    useCurrentButton.className = 'settings-use-current-view';
    useCurrentButton.textContent = t('settings.map.useCurrentView');
    useCurrentButton.addEventListener('click', () => {
        const map = activeMapInstance.get();
        if (!map || !loggedIn) return;
        const view = readCurrentView(map);
        draft.lat = view.lat;
        draft.lng = view.lng;
        draft.zoom = view.zoom;
        latField.update(view.lat);
        lngField.update(view.lng);
        zoomField.update(view.zoom);
        void writeHomeView();
    });

    const notMountedHint = document.createElement('div');
    notMountedHint.className = 'settings-use-current-view-hint';
    notMountedHint.textContent = t('settings.map.mapNotMounted');

    root.append(field(t('settings.map.homeView'), row), useCurrentButton, notMountedHint);
    container.append(root);

    const disposeStoreEffect = effect(() => {
        const settings = store.settings.get();
        const latFocused = document.activeElement === latField.input;
        const lngFocused = document.activeElement === lngField.input;
        const zoomFocused = document.activeElement === zoomField.input;

        if (!latFocused) draft.lat = settings.homeView.lat;
        if (!lngFocused) draft.lng = settings.homeView.lng;
        if (!zoomFocused) draft.zoom = settings.homeView.zoom;

        latField.update(settings.homeView.lat, !loggedIn);
        lngField.update(settings.homeView.lng, !loggedIn);
        zoomField.update(settings.homeView.zoom, !loggedIn);
    });

    const disposeMapEffect = effect(() => {
        const hasMap = activeMapInstance.get() !== null;
        useCurrentButton.disabled = !hasMap || !loggedIn;
        notMountedHint.style.display = hasMap ? 'none' : '';
    });

    return function dispose(): void {
        disposeStoreEffect();
        disposeMapEffect();
        root.remove();
    };
};
