/**
 * Layers section (artboard 07's "Lag" / "Levende lag"): generated from
 * `src/shared/layers.ts`'s `LiveLayerSpec` array -- one block per layer,
 * with zero code here that names a layer for the generic bits (enabled
 * toggle, poll-interval stepper, max-age stepper).
 *
 * The per-layer exceptions are a **deliberate** `layer.id` branch each,
 * documented rather than generalised away. A settings control is not
 * data: "Vis planlagt vegarbeid" means something only for roads, and a
 * scheme that rendered it from a schema would have to carry its label,
 * its help text and its ordering somewhere anyway. The branches:
 *  - `showOnGround` exists only on aircraft's settings shape.
 *  - `showPlanned` and `showCameras` exist only on roads'.
 *  - Ships gets one extra read-only line stating whether the server has
 *    BarentsWatch credentials configured, derived from `GET /api/ships`'s
 *    response shape (`503 {configured:false}` vs. any `200`), fetched
 *    once on mount.
 *
 * The max-age stepper is the one control that is conditional on the
 * *spec* rather than on an id: `maxAgeMinutesMin/Max` are optional on
 * `LiveLayerSpec`, and a layer that sets neither has no fix age to
 * filter on (roads: a notice is valid until it expires, never stale).
 */
import {
    AIRCRAFT_LAYER,
    ROADS_LAYER,
    SHIPS_LAYER,
    SPECIES_LAYER,
    TRANSIT_LAYER,
    WARNINGS_LAYER,
    type LiveLayerId,
    type LiveLayerSpec,
} from '../../../shared/layers.js';
import type { Settings, SettingsPatch, SpeciesDays } from '../../../shared/schemas/settings.js';
import { selectField, type SelectFieldHandle, type SelectFieldOption } from '../../components/SelectField.js';
import { stepper, type StepperHandle } from '../../components/Stepper.js';
import { toggle, type ToggleHandle } from '../../components/Toggle.js';
import { effect } from '../../core/signal.js';
import { formatNumber, t, type ParamlessKey } from '../../i18n/index.js';
import { field, overrideFor, type FieldHandle } from './field.js';
import type { SectionMount } from './sectionContext.js';

const LAYERS: readonly LiveLayerSpec<unknown>[] = [SHIPS_LAYER, AIRCRAFT_LAYER, ROADS_LAYER, TRANSIT_LAYER, WARNINGS_LAYER, SPECIES_LAYER];

const LAYER_LABEL_KEYS: Record<LiveLayerId, ParamlessKey> = {
    ships: 'settings.layers.ships',
    aircraft: 'settings.layers.aircraft',
    roads: 'settings.layers.roads',
    transit: 'settings.layers.transit',
    warnings: 'settings.layers.warnings',
    species: 'settings.layers.species',
};

/**
 * One layer's settings block, as the union of the three concrete shapes
 * -- `Settings[LiveLayerId]` read straight off `Settings`, with no cast
 * at all. That is what `LiveLayerId` being a closed union bought: the
 * correspondence "every layer id is also a `Settings` key" used to be a
 * comment above a double cast, and is now something the compiler checks.
 *
 * Being a union means the fields that are not shared (`maxAgeMinutes`,
 * `showOnGround`, `showPlanned`, `showCameras`) need an `in` narrowing
 * before they can be read -- which is the honest shape of the problem,
 * since roads genuinely has no `maxAgeMinutes`.
 */
type LiveLayerSettings = Settings[LiveLayerId];

function getLayerSettings(settings: Settings, layerId: LiveLayerId): LiveLayerSettings {
    return settings[layerId];
}

/** One layer's whole settings object under its own key -- the patch shape the store expects, with no cast, now that both sides of the key are the same closed union. */
function buildPatch(layerId: LiveLayerId, next: LiveLayerSettings): SettingsPatch {
    return { [layerId]: next };
}

async function checkShipsConfigured(): Promise<boolean | null> {
    try {
        const response = await fetch('/api/ships?bbox=-180,-90,180,90');
        if (response.status === 503) {
            const body: unknown = await response.json().catch(() => null);
            if (body && typeof body === 'object' && 'configured' in body && body.configured === false) {
                return false;
            }
            return null;
        }
        return response.ok ? true : null;
    } catch {
        return null;
    }
}

export const mount: SectionMount = (container, ctx) => {
    const root = document.createElement('div');
    root.className = 'settings-section-layers';

    const { store } = ctx;
    const initial = store.settings.get();

    const disposers: (() => void)[] = [];
    const rows: FieldHandle[] = [];

    for (const layer of LAYERS) {
        const block = document.createElement('div');
        block.className = 'settings-layer-block';

        const heading = document.createElement('div');
        heading.className = 'settings-layer-heading';
        heading.textContent = t(LAYER_LABEL_KEYS[layer.id]);

        const layerSettings = getLayerSettings(initial, layer.id);

        function write(next: Partial<LiveLayerSettings>): void {
            const current = getLayerSettings(store.settings.get(), layer.id);
            void store.patchSettings(buildPatch(layer.id, { ...current, ...next }));
        }

        const enabledToggle: ToggleHandle = toggle({
            checked: layerSettings.enabled,
            onChange: (checked) => {
                write({ enabled: checked });
            },
        });

        const pollStepper: StepperHandle = stepper({
            value: layerSettings.pollSeconds,
            min: layer.minPollSeconds,
            max: layer.maxPollSeconds,
            step: 5,
            formatValue: (v) => `${String(v)} ${t('unit.seconds')}`,
            onChange: (next) => {
                write({ pollSeconds: next });
            },
        });

        const headingRow = document.createElement('div');
        headingRow.className = 'settings-layer-heading-row';
        headingRow.append(heading, enabledToggle.el);

        // Every field in a block patches the one `ships`/`aircraft`/`roads`
        // object, so the block carries a single override on its first row
        // rather than one badge per control promising a granularity the
        // schema does not have. `layer.id` is usable as the override key
        // directly now that `LiveLayerId` is closed -- it used to be a
        // ternary picking between the only two ids that existed.
        const pollRow = field({
            label: t('settings.layers.pollSeconds'),
            control: pollStepper.el,
            override: overrideFor(store, layer.id, (shared) => `${formatNumber(shared.pollSeconds)} ${t('unit.seconds')}`),
        });
        rows.push(pollRow);
        block.append(headingRow, pollRow.el);

        // The max-age row, only for a layer that declares bounds for it.
        // `maxAgeMinutesMin/Max` and a `maxAgeMinutes` settings field
        // travel together by construction (`shared/layers.ts` says so),
        // and the `in` check is what tells TypeScript that -- `roads` is
        // in the same union and genuinely has no such field.
        const maxAgeMin = layer.maxAgeMinutesMin;
        const maxAgeMax = layer.maxAgeMinutesMax;
        let maxAgeStepper: StepperHandle | undefined;
        if (maxAgeMin !== undefined && maxAgeMax !== undefined && 'maxAgeMinutes' in layerSettings) {
            maxAgeStepper = stepper({
                value: layerSettings.maxAgeMinutes,
                min: maxAgeMin,
                max: maxAgeMax,
                step: 1,
                formatValue: (v) => `${String(v)} ${t('unit.minutes')}`,
                onChange: (next) => {
                    write({ maxAgeMinutes: next });
                },
            });
            const maxAgeRow = field({ label: t('settings.layers.maxAgeMinutes'), control: maxAgeStepper.el });
            rows.push(maxAgeRow);
            block.append(maxAgeRow.el);
        }

        // Aircraft-only field -- one of the documented per-layer-id
        // special cases. `initial.aircraft` rather than the union above:
        // inside this branch the shape is known, so the field is typed
        // rather than guarded.
        let showOnGroundToggle: ToggleHandle | undefined;
        if (layer.id === 'aircraft') {
            showOnGroundToggle = toggle({
                checked: initial.aircraft.showOnGround,
                onChange: (checked) => {
                    write({ showOnGround: checked });
                },
            });
            const showOnGroundRow = field({ label: t('settings.layers.showOnGround'), control: showOnGroundToggle.el });
            rows.push(showOnGroundRow);
            block.append(showOnGroundRow.el);
        }

        // Roads-only fields, the same deliberate id-branch.
        //
        // `showPlanned` is the Veg layer's answer to the max-age stepper
        // it does not have: a filter on the future ("is this happening
        // now?") where the others filter on the past ("is this fix still
        // any use?"). `showCameras` is separate from the layer's own
        // toggle because the camera pins are numerous, and wanting the
        // notices without them is an ordinary preference.
        let showPlannedToggle: ToggleHandle | undefined;
        let showCamerasToggle: ToggleHandle | undefined;
        if (layer.id === 'roads') {
            showPlannedToggle = toggle({
                checked: initial.roads.showPlanned,
                onChange: (checked) => {
                    write({ showPlanned: checked });
                },
            });
            const showPlannedRow = field({ label: t('settings.layers.showPlanned'), control: showPlannedToggle.el });
            showCamerasToggle = toggle({
                checked: initial.roads.showCameras,
                onChange: (checked) => {
                    write({ showCameras: checked });
                },
            });
            const showCamerasRow = field({ label: t('settings.layers.showCameras'), control: showCamerasToggle.el });
            rows.push(showPlannedRow, showCamerasRow);
            block.append(showPlannedRow.el, showCamerasRow.el);
        }

        // Transit-only fields, the same deliberate id-branch: which
        // vehicle kinds to draw, once the response is already on the map.
        let showBusesToggle: ToggleHandle | undefined;
        let showFerriesToggle: ToggleHandle | undefined;
        if (layer.id === 'transit') {
            showBusesToggle = toggle({
                checked: initial.transit.showBuses,
                onChange: (checked) => {
                    write({ showBuses: checked });
                },
            });
            const showBusesRow = field({ label: t('settings.layers.showBuses'), control: showBusesToggle.el });
            showFerriesToggle = toggle({
                checked: initial.transit.showFerries,
                onChange: (checked) => {
                    write({ showFerries: checked });
                },
            });
            const showFerriesRow = field({ label: t('settings.layers.showFerries'), control: showFerriesToggle.el });
            rows.push(showBusesRow, showFerriesRow);
            block.append(showBusesRow.el, showFerriesRow.el);
        }

        // Warnings-only field, the same deliberate id-branch: whether NVE's
        // avalanche outlines+pins draw alongside MET's weather polygons,
        // the analogue of `roads`' `showCameras` -- a way to keep half the
        // merged layer without the other.
        let showAvalancheToggle: ToggleHandle | undefined;
        if (layer.id === 'warnings') {
            showAvalancheToggle = toggle({
                checked: initial.warnings.showAvalanche,
                onChange: (checked) => {
                    write({ showAvalanche: checked });
                },
            });
            const showAvalancheRow = field({ label: t('settings.layers.showAvalanche'), control: showAvalancheToggle.el });
            rows.push(showAvalancheRow);
            block.append(showAvalancheRow.el);
        }

        // Species-only fields, the same deliberate id-branch: a
        // client-side kingdom filter, and the GBIF lookback window.
        //
        // The window is a `selectField` (segmented tiles), not a stepper:
        // a stepper implies a continuous range with a meaningful step
        // between values, and `settings.species.days` is a closed set of
        // four buckets the server caches its GBIF query by
        // (`SpeciesDaysSchema`). Every label states the window in days,
        // deliberately -- this data is never live, and the control must
        // not read as if it were (`species.ts`'s own header comment).
        // `selectField` is generic over `string`, so the four numbers are
        // carried in their own string form and parsed back to
        // `SpeciesDays` on write.
        let animalsOnlyToggle: ToggleHandle | undefined;
        let daysSelect: SelectFieldHandle<`${SpeciesDays}`> | undefined;
        if (layer.id === 'species') {
            animalsOnlyToggle = toggle({
                checked: initial.species.animalsOnly,
                onChange: (checked) => {
                    write({ animalsOnly: checked });
                },
            });
            const animalsOnlyRow = field({ label: t('settings.layers.animalsOnly'), control: animalsOnlyToggle.el });

            const daysOptions: SelectFieldOption<`${SpeciesDays}`>[] = [
                { value: '7', label: t('settings.layers.speciesDays7') },
                { value: '30', label: t('settings.layers.speciesDays30') },
                { value: '90', label: t('settings.layers.speciesDays90') },
                { value: '365', label: t('settings.layers.speciesDays365') },
            ];
            daysSelect = selectField({
                value: String(initial.species.days) as `${SpeciesDays}`,
                options: daysOptions,
                onChange: (next) => {
                    write({ days: Number(next) as SpeciesDays });
                },
            });
            const daysRow = field({ label: t('settings.layers.speciesDays'), control: daysSelect.el });

            rows.push(animalsOnlyRow, daysRow);
            block.append(animalsOnlyRow.el, daysRow.el);
        }

        // Ships-only read-only credentials line.
        let credentialsLine: HTMLElement | undefined;
        if (layer.id === 'ships') {
            credentialsLine = document.createElement('div');
            credentialsLine.className = 'settings-layer-credentials';
            credentialsLine.textContent = t('settings.layers.shipsCredentialsSet');
            block.append(credentialsLine);
            void checkShipsConfigured().then((configured) => {
                if (!credentialsLine) return;
                if (configured === false) {
                    credentialsLine.textContent = t('settings.layers.shipsCredentialsMissing');
                } else if (configured === true) {
                    credentialsLine.textContent = t('settings.layers.shipsCredentialsSet');
                }
                // `null` (network/parse failure): leave the optimistic default text.
            });
        }

        root.append(block);

        const disposeEffect = effect(() => {
            const current = getLayerSettings(store.settings.get(), layer.id);
            enabledToggle.setState(current.enabled, false);
            pollStepper.setState(current.pollSeconds, false);
            // Each control exists exactly when its field does; the `in`
            // checks re-establish that for the compiler on the union.
            if ('maxAgeMinutes' in current) maxAgeStepper?.setState(current.maxAgeMinutes, false);
            if ('showOnGround' in current) showOnGroundToggle?.setState(current.showOnGround, false);
            if ('showPlanned' in current) showPlannedToggle?.setState(current.showPlanned, false);
            if ('showCameras' in current) showCamerasToggle?.setState(current.showCameras, false);
            if ('showBuses' in current) showBusesToggle?.setState(current.showBuses, false);
            if ('showFerries' in current) showFerriesToggle?.setState(current.showFerries, false);
            if ('showAvalanche' in current) showAvalancheToggle?.setState(current.showAvalanche, false);
            if ('animalsOnly' in current) animalsOnlyToggle?.setState(current.animalsOnly, false);
            if ('days' in current) daysSelect?.setState(String(current.days) as `${SpeciesDays}`, false);
        });
        disposers.push(disposeEffect);
    }

    container.append(root);

    return function dispose(): void {
        for (const disposeOne of disposers) disposeOne();
        for (const row of rows) row.dispose();
        root.remove();
    };
};
