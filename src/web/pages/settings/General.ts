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
import { formatNumber, t } from '../../i18n/index.js';
import { field, overrideFor, type FieldHandle } from './field.js';
import type { SectionMount } from './sectionContext.js';

const PAGE_IDS: readonly PageId[] = ['map', 'weather', 'aurora', 'tide', 'cameras'];

const PAGE_NAV_KEYS: Record<PageId, 'nav.map' | 'nav.weather' | 'nav.aurora' | 'nav.tide' | 'nav.cameras'> = {
    map: 'nav.map',
    weather: 'nav.weather',
    aurora: 'nav.aurora',
    tide: 'nav.tide',
    cameras: 'nav.cameras',
};

export const mount: SectionMount = (container, ctx) => {
    const root = document.createElement('div');
    root.className = 'settings-section-general';

    const { store } = ctx;
    const initial = store.settings.get();

    const pollStepper: StepperHandle = stepper({
        value: initial.pollIntervalSeconds,
        min: 10,
        max: 600,
        step: 10,
        formatValue: (v) => `${String(v)} ${t('unit.seconds')}`,
        onChange: (next) => {
            void store.patchSettings({ pollIntervalSeconds: next });
        },
    });

    const languageSelect: SelectFieldHandle<Settings['language']> = selectField({
        value: initial.language,
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

    const rows: FieldHandle[] = [
        field({
            label: t('settings.general.pollInterval'),
            control: pollStepper.el,
            override: overrideFor(store, 'pollIntervalSeconds', (shared) => `${formatNumber(shared)} ${t('unit.seconds')}`),
        }),
        field({
            label: t('settings.general.language'),
            control: languageSelect.el,
            override: overrideFor(store, 'language', (shared) => t(shared === 'nb' ? 'settings.general.languageNb' : 'settings.general.languageEn')),
        }),
        field({
            label: t('settings.general.enabledPages'),
            control: pageTogglesRow,
            override: overrideFor(store, 'enabledPages', (shared) => shared.map((pageId) => t(PAGE_NAV_KEYS[pageId])).join(', ')),
        }),
    ];
    root.append(...rows.map((row) => row.el));
    container.append(root);

    const disposeEffect = effect(() => {
        const settings = store.settings.get();
        pollStepper.setState(settings.pollIntervalSeconds, false);
        languageSelect.setState(settings.language, false);
        for (const [pageId, handle] of pageToggles) {
            handle.setState(settings.enabledPages.includes(pageId), false);
        }
    });

    return function dispose(): void {
        disposeEffect();
        for (const row of rows) row.dispose();
        root.remove();
    };
};
