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
import { mergeSettings } from '../shared/settings-merge.js';
import { localOverrides } from './settings/localOverrides.js';

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
 * The shared, server-persisted settings exactly as the BFF reports them,
 * with no device overrides laid over the top.
 *
 * Only the settings page wants this: it shows "the shared value is X"
 * beside an overridden row, and needs the un-overridden value to do it.
 * Everything that merely *renders* the app wants `settings` below.
 *
 * Always populated: schema defaults while `idle`/`loading`, the last
 * successfully fetched value while `error` (if one exists), and schema
 * defaults again for an `error` with no prior success. A kiosk booted
 * with no network yet still renders a sane shell instead of blocking on
 * settings.
 */
export const serverSettings: ReadonlySignal<Settings> = computed(() => {
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

/**
 * What the app actually runs on: the shared settings with this device's
 * own overrides laid over them (`src/web/settings/localOverrides.ts`).
 *
 * This keeps the name `settings`, and every consumer -- i18n, the
 * masthead, the night overlay, the idle timer, the auto-cycle, the map's
 * home view, both live layers -- reads it unchanged. That is deliberate:
 * "the settings this device is running on" is what all of them have always
 * meant, and the arrival of a device-local layer underneath does not
 * change the question any of them is asking.
 */
export const settings: ReadonlySignal<Settings> = computed(() => mergeSettings(serverSettings.get(), localOverrides.get()));
