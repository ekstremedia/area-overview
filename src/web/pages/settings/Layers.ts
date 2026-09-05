/**
 * Layers section (artboard 07's "Lag" / "Levende lag"): generated from
 * `src/shared/layers.ts`'s `LiveLayerSpec` array -- one block per layer,
 * with zero code here that names "ships" or "aircraft" for the generic
 * bits (enabled toggle, poll-interval stepper, max-age stepper). A third
 * live layer added to that array needs no change in this file.
 *
 * Two genuinely per-layer exceptions, both documented, not hidden:
 *  - `showOnGround` only exists on aircraft's settings shape -- handled
 *    as an explicit `layer.id === 'aircraft'` special case, exactly as
 *    the phase notes call out.
 *  - Ships gets one extra read-only line stating whether the server has
 *    BarentsWatch credentials configured, derived from `GET /api/ships`'s
 *    response shape (`503 {configured:false}` vs. any `200`), fetched
 *    once on mount.
 */
import { AIRCRAFT_LAYER, SHIPS_LAYER, type LiveLayerSpec } from '../../../shared/layers.js';
import type { Settings, SettingsPatch } from '../../../shared/schemas/settings.js';
import { stepper, type StepperHandle } from '../../components/Stepper.js';
import { toggle, type ToggleHandle } from '../../components/Toggle.js';
import { effect } from '../../core/signal.js';
import { t, type ParamlessKey } from '../../i18n/index.js';
import type { SectionMount } from './sectionContext.js';

const LAYERS: readonly LiveLayerSpec<unknown>[] = [SHIPS_LAYER, AIRCRAFT_LAYER];

const LAYER_LABEL_KEYS: Record<string, ParamlessKey> = {
    ships: 'settings.layers.ships',
    aircraft: 'settings.layers.aircraft',
};

/** The fields every live layer's settings share -- `showOnGround` is aircraft-only, handled separately. */
interface LiveLayerSettingsShape {
    enabled: boolean;
    pollSeconds: number;
    maxAgeMinutes: number;
    showOnGround?: boolean;
}

function getLayerSettings(settings: Settings, layerId: string): LiveLayerSettingsShape {
    // `Settings`'s `ships`/`aircraft` keys are exactly `LiveLayerSpec.id`'s
    // two current values -- this cast is the one place that fact is
    // asserted rather than re-derived structurally, since `Settings` has
    // no generic `Record<layerId, ...>` shape for TS to index into directly.
    // The trailing non-null assertion is safe for the same reason: `layerId`
    // always comes from `LAYERS` (`SHIPS_LAYER`/`AIRCRAFT_LAYER`), both of
    // which name a real top-level `Settings` key.
    const record = settings as unknown as Record<string, LiveLayerSettingsShape>;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- see comment above
    return record[layerId]!;
}

function buildPatch(layerId: string, next: LiveLayerSettingsShape): SettingsPatch {
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
    root.className = 'settings-section-layers';

    const { store } = ctx;
    const loggedIn = ctx.loggedIn;
    const initial = store.settings.get();

    const disposers: (() => void)[] = [];

    for (const layer of LAYERS) {
        const block = document.createElement('div');
        block.className = 'settings-layer-block';

        const heading = document.createElement('div');
        heading.className = 'settings-layer-heading';
        heading.textContent = t(LAYER_LABEL_KEYS[layer.id] ?? 'settings.layers.ships');

        const layerSettings = getLayerSettings(initial, layer.id);

        function write(next: Partial<LiveLayerSettingsShape>): void {
            const current = getLayerSettings(store.settings.get(), layer.id);
            void store.patchSettings(buildPatch(layer.id, { ...current, ...next }));
        }

        const enabledToggle: ToggleHandle = toggle({
            checked: layerSettings.enabled,
            disabled: !loggedIn,
            onChange: (checked) => {
                write({ enabled: checked });
            },
        });

        const pollStepper: StepperHandle = stepper({
            value: layerSettings.pollSeconds,
            min: layer.minPollSeconds,
            max: layer.maxPollSeconds,
            step: 5,
            disabled: !loggedIn,
            formatValue: (v) => `${String(v)} ${t('unit.seconds')}`,
            onChange: (next) => {
                write({ pollSeconds: next });
            },
        });

        const maxAgeStepper: StepperHandle = stepper({
            value: layerSettings.maxAgeMinutes,
            min: layer.maxAgeMinutesMin,
            max: layer.maxAgeMinutesMax,
            step: 1,
            disabled: !loggedIn,
            formatValue: (v) => `${String(v)} ${t('unit.minutes')}`,
            onChange: (next) => {
                write({ maxAgeMinutes: next });
            },
        });

        const headingRow = document.createElement('div');
        headingRow.className = 'settings-layer-heading-row';
        headingRow.append(heading, enabledToggle.el);

        block.append(
            headingRow,
            field(t('settings.layers.pollSeconds'), pollStepper.el),
            field(t('settings.layers.maxAgeMinutes'), maxAgeStepper.el),
        );

        // Aircraft-only field -- the one documented per-layer-id special case.
        let showOnGroundToggle: ToggleHandle | undefined;
        if (layer.id === 'aircraft') {
            showOnGroundToggle = toggle({
                checked: layerSettings.showOnGround ?? false,
                disabled: !loggedIn,
                onChange: (checked) => {
                    write({ showOnGround: checked });
                },
            });
            block.append(field(t('settings.layers.showOnGround'), showOnGroundToggle.el));
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
            enabledToggle.setState(current.enabled, !loggedIn);
            pollStepper.setState(current.pollSeconds, !loggedIn);
            maxAgeStepper.setState(current.maxAgeMinutes, !loggedIn);
            showOnGroundToggle?.setState(current.showOnGround ?? false, !loggedIn);
        });
        disposers.push(disposeEffect);
    }

    container.append(root);

    return function dispose(): void {
        for (const disposeOne of disposers) disposeOne();
        root.remove();
    };
};
