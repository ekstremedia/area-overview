/**
 * The frontend's read side of `GET /api/settings` (public, no password --
 * see `src/server/routes/settings.ts`). Built on Phase 4's `resource()`
 * so the rest of the app never touches a bare `Promise`: `settings` below
 * is a `ReadonlySignal<Settings>` that always has a value (falling back
 * to schema defaults while loading, or to the last-known-good value on a
 * transient fetch error), so consumers (i18n, the masthead, the night
 * overlay) can read it unconditionally instead of branching on
 * idle/loading/error every time.
 *
 * Module-scope singleton, started once on first import (same pattern as
 * `src/web/core/router.ts`'s `currentRoute`). Tests that need a
 * controllable settings value mock this whole module (`vi.mock(...)`)
 * rather than reaching into the resource's polling internals.
 */
import { err, ok, type Result } from '../shared/result.js';
import { SettingsSchema, type Settings } from '../shared/schemas/settings.js';
import { computed, type ReadonlySignal } from './core/signal.js';
import { resource, type Resource } from './core/resource.js';

const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** How often the kiosk re-fetches shared settings from the BFF. */
const SETTINGS_POLL_INTERVAL_MS = 30_000;

async function fetchSettings(): Promise<Result<Settings>> {
    try {
        const response = await fetch('/api/settings');
        if (!response.ok) {
            return err({ message: `GET /api/settings responded ${String(response.status)}` });
        }
        const json: unknown = await response.json();
        const parsed = SettingsSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/settings returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/settings', cause });
    }
}

export const settingsResource: Resource<Settings> = resource(fetchSettings, { intervalMs: SETTINGS_POLL_INTERVAL_MS });

/**
 * Always-populated view over `settingsResource`'s state: schema defaults
 * while `idle`/`loading`, the last successfully fetched value while
 * `error` (if one exists), and schema defaults again for an `error` with
 * no prior success. A kiosk booted with no network yet still renders a
 * sane shell instead of blocking on settings.
 */
export const settings: ReadonlySignal<Settings> = computed(() => {
    const state = settingsResource.state.get();
    switch (state.status) {
        case 'ready':
            return state.data;
        case 'error':
            return state.lastData ?? DEFAULT_SETTINGS;
        case 'idle':
        case 'loading':
            return DEFAULT_SETTINGS;
    }
});
