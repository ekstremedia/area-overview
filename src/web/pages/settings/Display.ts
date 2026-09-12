/**
 * Display section (artboard 07's "Visning") -- shared night/brightness/
 * idle-reset controls combined with the device's own theme/font-scale
 * controls, presented together as one section per the phase notes
 * ("Appearance folds into Display as its device-settings half").
 *
 * Device settings (`theme`, `fontScale`) are NEVER locked -- editable
 * whether logged in or not, since they're local-only and harmless (see
 * `device-settings.ts`'s own doc comment: never sent to or read from the
 * server). Every other control here is a shared setting and follows the
 * page's normal logged-out-is-read-only rule.
 *
 * `night` is a compound object (`enabled`/`from`/`to`/`mode`) patched as
 * one whole `SettingsPatch.night` on every write -- a local `draft`
 * mirrors it so each control (the enabled toggle, two `TimeField`s, the
 * mode select) always composes a full, coherent object regardless of
 * which one last changed. `draft`'s two time fields are only re-synced
 * from the store while their own input isn't focused (`TimeField.update`
 * already guards this at the DOM level; the same guard is applied here at
 * the draft level so a write in flight for one field can't lose a
 * same-tick, not-yet-sent edit to the other -- see `sharedStore.ts`'s
 * `pendingFields` doc comment for why this matters).
 *
 * Auto-cycle (`enabled`/`intervalSeconds`/`pages`) is the same kind of
 * kiosk-display-timing control as idle-reset, so it lives here rather
 * than in `General.ts` -- landed next to idle reset specifically, since
 * both are "how long before the display does something on its own"
 * settings. `intervalSeconds`'s stepper follows `idleResetSeconds`'s own
 * precedent exactly (raw seconds, no separate minutes input): this app
 * has no other duration control that lets the user type minutes, so
 * inventing one here just for this field would be a new, inconsistent
 * pattern rather than a reused one. The page picker reuses `General.ts`'s
 * `enabledPages` checklist pattern -- five toggles, one per `PageId` --
 * with the empty-selection state read as "all", matching
 * `AutoCycleSchema.pages`'s own sentinel (see that schema's doc comment).
 */
import type { PageId, Settings } from '../../../shared/schemas/settings.js';
import type { DeviceSettings } from '../../../shared/schemas/device-settings.js';
import { selectField, type SelectFieldHandle } from '../../components/SelectField.js';
import { stepper, type StepperHandle } from '../../components/Stepper.js';
import { timeField, type TimeFieldHandle } from '../../components/TimeField.js';
import { toggle, type ToggleHandle } from '../../components/Toggle.js';
import { effect } from '../../core/signal.js';
import { deviceSettings, setDeviceSettings } from '../../device-settings.js';
import { formatNumber, t } from '../../i18n/index.js';
import { field, overrideFor, type FieldHandle } from './field.js';
import type { SectionMount } from './sectionContext.js';

const AUTO_CYCLE_PAGE_IDS: readonly PageId[] = ['map', 'weather', 'aurora', 'tide', 'cameras'];

const AUTO_CYCLE_PAGE_NAV_KEYS: Record<PageId, 'nav.map' | 'nav.weather' | 'nav.aurora' | 'nav.tide' | 'nav.cameras'> = {
    map: 'nav.map',
    weather: 'nav.weather',
    aurora: 'nav.aurora',
    tide: 'nav.tide',
    cameras: 'nav.cameras',
};

export const mount: SectionMount = (container, ctx) => {
    const root = document.createElement('div');
    root.className = 'settings-section-display';

    const { store } = ctx;
    const initial = store.settings.get();

    const disposers: (() => void)[] = [];

    // — Idle reset —
    const idleResetStepper: StepperHandle = stepper({
        value: initial.idleResetSeconds,
        min: 0,
        max: 3600,
        step: 30,
        formatValue: (v) => (v === 0 ? t('settings.display.idleResetOff') : `${String(v)} ${t('unit.seconds')}`),
        onChange: (next) => {
            void store.patchSettings({ idleResetSeconds: next });
        },
    });

    // — Brightness —
    const brightnessStepper: StepperHandle = stepper({
        value: initial.brightness,
        min: 20,
        max: 100,
        step: 10,
        formatValue: (v) => `${String(v)} ${t('unit.percent')}`,
        onChange: (next) => {
            void store.patchSettings({ brightness: next });
        },
    });

    // — Night schedule (compound) —
    const nightDraft: Settings['night'] = { ...initial.night };

    function writeNight(next: Partial<Settings['night']>): void {
        Object.assign(nightDraft, next);
        void store.patchSettings({ night: { ...nightDraft } });
    }

    const nightEnabledToggle: ToggleHandle = toggle({
        checked: nightDraft.enabled,
        onChange: (checked) => {
            writeNight({ enabled: checked });
        },
    });

    const nightFromField: TimeFieldHandle = timeField({
        value: nightDraft.from,
        id: 'settings-night-from',
        write: (value) => {
            nightDraft.from = value;
            return store.patchSettings({ night: { ...nightDraft } });
        },
    });

    const nightToField: TimeFieldHandle = timeField({
        value: nightDraft.to,
        id: 'settings-night-to',
        write: (value) => {
            nightDraft.to = value;
            return store.patchSettings({ night: { ...nightDraft } });
        },
    });

    const nightModeSelect: SelectFieldHandle<Settings['night']['mode']> = selectField({
        value: nightDraft.mode,
        options: [
            { value: 'dim', label: t('settings.display.modeDim') },
            { value: 'dark', label: t('settings.display.modeDark') },
            { value: 'off', label: t('settings.display.modeOff') },
        ],
        onChange: (next) => {
            writeNight({ mode: next });
        },
    });

    const nightRow = document.createElement('div');
    nightRow.className = 'settings-night-row';
    nightRow.append(nightEnabledToggle.el, nightFromField.el, nightToField.el, nightModeSelect.el);

    // — Auto-cycle (compound: enabled/intervalSeconds/pages) —
    const autoCycleDraft: Settings['autoCycle'] = { ...initial.autoCycle, pages: [...initial.autoCycle.pages] };

    function writeAutoCycle(next: Partial<Settings['autoCycle']>): void {
        Object.assign(autoCycleDraft, next);
        void store.patchSettings({ autoCycle: { ...autoCycleDraft, pages: [...autoCycleDraft.pages] } });
    }

    const autoCycleEnabledToggle: ToggleHandle = toggle({
        accessibleLabel: t('settings.display.autoCycle'),
        checked: autoCycleDraft.enabled,
        onChange: (checked) => {
            writeAutoCycle({ enabled: checked });
        },
    });

    const autoCycleIntervalStepper: StepperHandle = stepper({
        value: autoCycleDraft.intervalSeconds,
        min: 30,
        max: 3600,
        step: 30,
        formatValue: (v) => `${String(v)} ${t('unit.seconds')}`,
        onChange: (next) => {
            writeAutoCycle({ intervalSeconds: next });
        },
    });

    // Empty `pages` is the "cycle every currently-enabled page" sentinel
    // (see `AutoCycleSchema`'s doc comment) -- no explicit "all" toggle,
    // just this hint text below the checklist when nothing is checked.
    const autoCyclePageToggles = new Map<PageId, ToggleHandle>();
    const autoCyclePageTogglesRow = document.createElement('div');
    autoCyclePageTogglesRow.className = 'settings-page-toggles';
    for (const pageId of AUTO_CYCLE_PAGE_IDS) {
        const handle = toggle({
            label: t(AUTO_CYCLE_PAGE_NAV_KEYS[pageId]),
            checked: autoCycleDraft.pages.includes(pageId),
            onChange: (checked) => {
                const current = autoCycleDraft.pages;
                const next = checked
                    ? [...current, pageId].filter((id, index, all) => all.indexOf(id) === index)
                    : current.filter((id) => id !== pageId);
                writeAutoCycle({ pages: AUTO_CYCLE_PAGE_IDS.filter((id) => next.includes(id)) });
            },
        });
        autoCyclePageToggles.set(pageId, handle);
        autoCyclePageTogglesRow.append(handle.el);
    }

    const autoCyclePagesHint = document.createElement('p');
    autoCyclePagesHint.className = 'settings-auto-cycle-hint';

    const autoCyclePagesField = document.createElement('div');
    autoCyclePagesField.append(autoCyclePageTogglesRow, autoCyclePagesHint);

    // — Device: theme (always editable) —
    const deviceInitial = deviceSettings.get();
    const themeSelect: SelectFieldHandle<DeviceSettings['theme']> = selectField({
        value: deviceInitial.theme,
        options: [
            { value: 'dark', label: t('settings.display.themeDark') },
            { value: 'light', label: t('settings.display.themeLight') },
            { value: 'system', label: t('settings.display.themeSystem') },
        ],
        onChange: (next) => {
            setDeviceSettings({ theme: next });
        },
    });

    // — Device: font scale (always editable) —
    const fontScaleStepper: StepperHandle = stepper({
        value: deviceInitial.fontScale,
        min: 0.8,
        max: 1.6,
        step: 0.1,
        formatValue: (v) => `${v.toFixed(1)}x`,
        onChange: (next) => {
            setDeviceSettings({ fontScale: next });
        },
    });

    const nightSummary = (night: Settings['night']): string =>
        night.enabled ? `${night.from}\u2013${night.to}` : t('settings.display.idleResetOff');

    const rows: FieldHandle[] = [
        field({
            label: t('settings.display.idleReset'),
            control: idleResetStepper.el,
            override: overrideFor(store, 'idleResetSeconds', (shared) =>
                shared === 0 ? t('settings.display.idleResetOff') : `${formatNumber(shared)} ${t('unit.seconds')}`,
            ),
        }),
        field({
            label: t('settings.display.brightness'),
            control: brightnessStepper.el,
            override: overrideFor(store, 'brightness', (shared) => `${formatNumber(shared)} ${t('unit.percent')}`),
        }),
        field({
            label: t('settings.display.nightSchedule'),
            control: nightRow,
            override: overrideFor(store, 'night', nightSummary),
        }),
        // All three auto-cycle rows edit one `autoCycle` object, so they
        // share a single override: taking one over takes the lot, and
        // handing any of them back hands all three back. Showing three
        // independent badges would promise a granularity the schema does
        // not have.
        field({
            label: t('settings.display.autoCycle'),
            control: autoCycleEnabledToggle.el,
            override: overrideFor(store, 'autoCycle', (shared) =>
                shared.enabled ? t('settings.account.loggedIn') : t('settings.display.idleResetOff'),
            ),
        }),
        field({ label: t('settings.display.autoCycleInterval'), control: autoCycleIntervalStepper.el }),
        field({ label: t('settings.display.autoCyclePages'), control: autoCyclePagesField }),
        // Theme and font scale have always been device-local and have no
        // shared counterpart at all, so they get no badge: there is
        // nothing to hand them back to.
        field({ label: t('settings.display.theme'), control: themeSelect.el }),
        field({ label: t('settings.display.fontScale'), control: fontScaleStepper.el }),
    ];
    root.append(...rows.map((row) => row.el));
    container.append(root);

    disposers.push(
        effect(() => {
            const settings = store.settings.get();
            idleResetStepper.setState(settings.idleResetSeconds, false);
            brightnessStepper.setState(settings.brightness, false);
            nightEnabledToggle.setState(settings.night.enabled, false);
            nightModeSelect.setState(settings.night.mode, false);

            const fromFocused = document.activeElement === nightFromField.input;
            const toFocused = document.activeElement === nightToField.input;
            if (!fromFocused) nightDraft.from = settings.night.from;
            if (!toFocused) nightDraft.to = settings.night.to;
            nightDraft.enabled = settings.night.enabled;
            nightDraft.mode = settings.night.mode;
            nightFromField.update(settings.night.from, false);
            nightToField.update(settings.night.to, false);

            autoCycleEnabledToggle.setState(settings.autoCycle.enabled, false);
            autoCycleIntervalStepper.setState(settings.autoCycle.intervalSeconds, false);
            autoCycleDraft.enabled = settings.autoCycle.enabled;
            autoCycleDraft.intervalSeconds = settings.autoCycle.intervalSeconds;
            autoCycleDraft.pages = [...settings.autoCycle.pages];
            for (const [pageId, handle] of autoCyclePageToggles) {
                handle.setState(settings.autoCycle.pages.includes(pageId), false);
            }
            autoCyclePagesHint.textContent = settings.autoCycle.pages.length === 0 ? t('settings.display.autoCyclePagesAllHint') : '';
        }),
    );

    disposers.push(
        effect(() => {
            const current = deviceSettings.get();
            themeSelect.setState(current.theme);
            fontScaleStepper.setState(current.fontScale);
        }),
    );

    return function dispose(): void {
        for (const disposeOne of disposers) disposeOne();
        for (const row of rows) row.dispose();
        root.remove();
    };
};
