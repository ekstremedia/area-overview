/**
 * General section (artboard 07's "Generelt"): poll interval (a stepper,
 * matching `pollIntervalSeconds`'s 10-600s/10s-step range), language (a
 * two-tile select that -- via `t()`'s own reactivity -- re-renders the
 * whole app immediately, no reload), and the five toggleable content
 * pages (`enabledPages`). Settings itself is never a toggleable entry --
 * `PAGE_IDS` below is exactly `PageId`'s five members, not `Route['name']`.
 */
import type { PageId, Settings } from '../../../shared/schemas/settings.js';
import { selectField, type SelectFieldHandle } from '../../components/SelectField.js';
import { stepper, type StepperHandle } from '../../components/Stepper.js';
import { toggle, type ToggleHandle } from '../../components/Toggle.js';
import { effect } from '../../core/signal.js';
import { t } from '../../i18n/index.js';
import type { SectionMount } from './sectionContext.js';

const PAGE_IDS: readonly PageId[] = ['map', 'weather', 'aurora', 'tide', 'cameras'];

const PAGE_NAV_KEYS: Record<PageId, 'nav.map' | 'nav.weather' | 'nav.aurora' | 'nav.tide' | 'nav.cameras'> = {
    map: 'nav.map',
    weather: 'nav.weather',
    aurora: 'nav.aurora',
    tide: 'nav.tide',
    cameras: 'nav.cameras',
};

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
    root.className = 'settings-section-general';

    const { store } = ctx;
    const initial = store.settings.get();
    const loggedIn = ctx.loggedIn;

    const pollStepper: StepperHandle = stepper({
        value: initial.pollIntervalSeconds,
        min: 10,
        max: 600,
        step: 10,
        disabled: !loggedIn,
        formatValue: (v) => `${String(v)} ${t('unit.seconds')}`,
        onChange: (next) => {
            void store.patchSettings({ pollIntervalSeconds: next });
        },
    });

    const languageSelect: SelectFieldHandle<Settings['language']> = selectField({
        value: initial.language,
        disabled: !loggedIn,
        options: [
            { value: 'nb', label: t('settings.general.languageNb') },
            { value: 'en', label: t('settings.general.languageEn') },
        ],
        onChange: (next) => {
            void store.patchSettings({ language: next });
        },
    });

    const pageToggles = new Map<PageId, ToggleHandle>();
    const pageTogglesRow = document.createElement('div');
    pageTogglesRow.className = 'settings-page-toggles';
    for (const pageId of PAGE_IDS) {
        const handle = toggle({
            label: t(PAGE_NAV_KEYS[pageId]),
            checked: initial.enabledPages.includes(pageId),
            disabled: !loggedIn,
            onChange: (checked) => {
                const current = store.settings.get().enabledPages;
                const next = checked
                    ? [...current, pageId].filter((id, index, all) => all.indexOf(id) === index)
                    : current.filter((id) => id !== pageId);
                void store.patchSettings({ enabledPages: PAGE_IDS.filter((id) => next.includes(id)) });
            },
        });
        pageToggles.set(pageId, handle);
        pageTogglesRow.append(handle.el);
    }

    root.append(
        field(t('settings.general.pollInterval'), pollStepper.el),
        field(t('settings.general.language'), languageSelect.el),
        field(t('settings.general.enabledPages'), pageTogglesRow),
    );
    container.append(root);

    const disposeEffect = effect(() => {
        const settings = store.settings.get();
        pollStepper.setState(settings.pollIntervalSeconds, !loggedIn);
        languageSelect.setState(settings.language, !loggedIn);
        for (const [pageId, handle] of pageToggles) {
            handle.setState(settings.enabledPages.includes(pageId), !loggedIn);
        }
    });

    return function dispose(): void {
        disposeEffect();
        root.remove();
    };
};
