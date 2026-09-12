/**
 * One labelled row in a settings section, and the badge that says whether
 * this device has taken the field over.
 *
 * Folded out of four near-identical local `field()` helpers (General,
 * Display, Map, Layers -- the Map one an awkward two-overload function)
 * because the badge has to appear on every row, and four copies of the row
 * markup means four places to add it to and four chances to disagree.
 *
 * The badge only appears when a field is actually overridden, so a kiosk
 * following the shared settings -- which is every row on Terje's wall
 * display -- looks exactly as it did before this existed.
 */
import type { Settings, SettingsOverride } from '../../../shared/schemas/settings.js';
import { effect } from '../../core/signal.js';
import { t } from '../../i18n/index.js';
import type { SettingsStore } from '../../settings/sharedStore.js';

export interface FieldOverride {
    /** Whether this device is currently using its own value for this field. Read inside an `effect()`, so the badge appears and vanishes reactively. */
    isOverridden: () => boolean;
    /** The shared value in words, for the hint beside the button -- so a visitor can see what they would be going back to before pressing it. */
    sharedText: () => string;
    /** Hand this field back to the shared value. */
    onUseShared: () => void;
}

export interface FieldOptions {
    label: string;
    control: HTMLElement;
    /** Set when the control has a real focusable input, so the `<label>` points at it. */
    inputId?: string;
    /** Omitted for a field no device can override (camera placements), which then never grows a badge. */
    override?: FieldOverride;
}

export interface FieldHandle {
    el: HTMLElement;
    /** Tears down the badge's reactive effect. Sections that build rows must call this. */
    dispose: () => void;
}

/**
 * The standard override descriptor for one settings field: overridden
 * when this device holds a value for it, and "use shared" hands it back.
 *
 * `format` renders the *shared* value for the hint, so a visitor can see
 * what pressing the button would give them. It is passed the server's
 * value, never the effective one -- showing the value they already have
 * would make the button look like a no-op.
 */
export function overrideFor<K extends keyof SettingsOverride>(
    store: SettingsStore,
    fieldName: K,
    format: (shared: Settings[K]) => string,
): FieldOverride {
    return {
        isOverridden: () => store.overrides.get()[fieldName] !== undefined,
        sharedText: () => format(store.serverSettings.get()[fieldName]),
        onUseShared: () => {
            void store.clearOverride(fieldName);
        },
    };
}

export function field(options: FieldOptions): FieldHandle {
    const row = document.createElement('div');
    row.className = 'settings-field';

    // A `<label>` regardless of whether there is an `inputId`: it costs
    // nothing without a `for`, and it keeps one element type across every
    // row rather than a `<div>` here and a `<label>` there.
    const label = document.createElement('label');
    label.className = 'settings-field-label';
    if (options.inputId !== undefined) label.htmlFor = options.inputId;
    label.textContent = options.label;

    row.append(label, options.control);

    const override = options.override;
    if (!override) {
        return { el: row, dispose: () => undefined };
    }

    const note = document.createElement('div');
    note.className = 'settings-field-override';

    const badge = document.createElement('span');
    badge.className = 'settings-field-override-badge';
    badge.textContent = t('settings.override.thisDeviceOnly');

    const useShared = document.createElement('button');
    useShared.type = 'button';
    useShared.className = 'settings-field-override-reset';
    useShared.addEventListener('click', () => {
        override.onUseShared();
    });

    note.append(badge, useShared);
    row.append(note);

    const disposeEffect = effect(() => {
        const overridden = override.isOverridden();
        // `hidden` rather than removing the node: the row must not change
        // height as a value is overridden and handed back, or a list of
        // settings jumps under the finger that is editing it.
        note.hidden = !overridden;
        if (overridden) {
            useShared.textContent = t('settings.override.useShared', { value: override.sharedText() });
        }
    });

    return {
        el: row,
        dispose: () => {
            disposeEffect();
        },
    };
}
