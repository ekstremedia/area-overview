/**
 * Lays a device's own overrides over the shared server settings.
 *
 * The merge is **shallow at the top level**, and that is a decision rather
 * than a shortcut: every override value is produced by the same whole-field
 * schema that produces a `SettingsPatch` value, so `night` is always a
 * complete `{enabled, from, to, mode}` and never half of one. A deep merge
 * would admit partial objects no schema validates, and would turn "is this
 * field overridden?" -- which the settings page has to answer on every row
 * -- into a per-leaf question instead of a per-field one.
 */
import { OVERRIDABLE_FIELDS, type Settings, type SettingsOverride } from './schemas/settings.js';

/** `base` with every field the device has overridden replaced. Returns a new object; neither argument is mutated. */
export function mergeSettings(base: Settings, overrides: SettingsOverride): Settings {
    return { ...base, ...definedEntries(overrides) };
}

/**
 * The fields this device has actually overridden.
 *
 * A key present with an `undefined` value is not an override -- that is
 * what a cleared field looks like mid-flight before it is deleted, and
 * spreading it over `base` would blank a real setting.
 */
export function overriddenFields(overrides: SettingsOverride): (keyof SettingsOverride)[] {
    return OVERRIDABLE_FIELDS.filter((field) => overrides[field] !== undefined);
}

function definedEntries(overrides: SettingsOverride): Partial<Settings> {
    const defined: Partial<Settings> = {};
    for (const field of overriddenFields(overrides)) {
        // Each key's override type is exactly its `Settings` type, but TS
        // cannot see that through the dynamic key, so this narrows through
        // one assignment rather than eleven hand-written branches.
        Object.assign(defined, { [field]: overrides[field] });
    }
    return defined;
}
