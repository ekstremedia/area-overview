/**
 * The context every settings section's `mount(container, ctx)` receives.
 * `loggedIn` is a snapshot, not a reactive value: `SettingsPage.ts`
 * re-mounts the active section whenever `isLoggedIn` changes, so a fresh
 * mount always sees the current value -- a section itself never needs to
 * watch `isLoggedIn` reactively.
 */
import type { SettingsStore } from '../../settings/sharedStore.js';

export interface SectionContext {
    store: SettingsStore;
    loggedIn: boolean;
}

export type SectionMount = (container: HTMLElement, ctx: SectionContext) => () => void;
