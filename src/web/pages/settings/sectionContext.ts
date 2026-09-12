/**
 * The context every settings section's `mount(container, ctx)` receives.
 * `loggedIn` is a snapshot, not a reactive value: `SettingsPage.ts`
 * re-mounts the active section whenever `isLoggedIn` changes, so a fresh
 * mount always sees the current value -- a section itself never needs to
 * watch `isLoggedIn` reactively.
 *
 * What `loggedIn` *means* changed when the app went public. It used to
 * decide whether a control was editable at all; now almost every control
 * is editable either way, and it decides only where the edit lands --
 * the shared settings, or this device's own overrides (see
 * `settings/localOverrides.ts`). Sections use it for wording, not for
 * `disabled`.
 *
 * The two exceptions, both still genuinely password-only: camera
 * placements (shared content, not a preference) and anything the server
 * itself enforces.
 */
import type { SettingsStore } from '../../settings/sharedStore.js';

export interface SectionContext {
    store: SettingsStore;
    loggedIn: boolean;
}

export type SectionMount = (container: HTMLElement, ctx: SectionContext) => () => void;
