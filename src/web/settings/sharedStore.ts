/**
 * The write-capable view over shared settings used by the settings page.
 * Deliberately a *separate* instance from `src/web/settings-resource.ts`'s
 * module-scope, read-only `settings` singleton (which every other page
 * keeps reading, unaffected by anything in here) -- created fresh by
 * `SettingsPage.ts` on mount and disposed on unmount, same lifecycle
 * pattern as `WeatherPage.ts`'s own page-scoped `resource()` instances.
 *
 * The trickiest correctness requirement in this module: the underlying
 * poll of `GET /api/settings` runs independently of any in-flight write.
 * If a poll response (or another write's own authoritative response)
 * arrives while a specific top-level field has an unflushed local edit,
 * that field must keep its local, in-flight value rather than being
 * clobbered by a snapshot that predates the edit finishing. `pendingFields`
 * tracks exactly which top-level `Settings` keys are currently "being
 * written" (from either `patchSettings` or `setPlacement`, both of which
 * ultimately touch top-level keys -- `placements` for the latter); every
 * incoming server snapshot is merged against it via `mergeServerSnapshot`,
 * so every *other* field updates normally while pending ones don't.
 *
 * `pendingFields` is a reference count (`Map<keyof Settings, number>`), not
 * a `Set`: if two writes touch the same field and their in-flight windows
 * overlap (e.g. two rapid edits to the same field before the first
 * request resolves), the field must stay "pending" until *both* writes
 * have settled, not just the first one to finish. A `Set` with an
 * unconditional delete-on-settle would let the first write's completion
 * clear the mark while the second is still in flight, exposing a window
 * where a poll can clobber the second write's optimistic value.
 */
import { err, ok, type Result } from '../../shared/result.js';
import { SettingsSchema, type Placement, type Settings, type SettingsOverride, type SettingsPatch } from '../../shared/schemas/settings.js';
import { mergeSettings } from '../../shared/settings-merge.js';
import { resource } from '../core/resource.js';
import { computed, effect, signal, type ReadonlySignal } from '../core/signal.js';
import { clearLocalOverride, localOverrides, setLocalOverride } from './localOverrides.js';
import { authHeaders, isLoggedIn, logout } from './session.js';

const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** Matches `settings-resource.ts`'s own cadence -- this is a second, independent poll of the same endpoint, scoped to the settings page's lifetime. */
export const SHARED_STORE_POLL_INTERVAL_MS = 30_000;

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

function isUnauthorized(status: number): boolean {
    return status === 401;
}

export interface SettingsStore {
    /** What this device is actually running on: the shared settings with its own overrides laid over them. This is what a control renders from. */
    settings: ReadonlySignal<Settings>;
    /** The shared settings as the server reports them, un-overridden -- for showing "the shared value is X" beside a row this device has taken over. */
    serverSettings: ReadonlySignal<Settings>;
    /** Which fields this device has taken over, and what it set them to. */
    overrides: ReadonlySignal<SettingsOverride>;
    /**
     * Applies `patch` to wherever this device's edits belong: the shared
     * settings when logged in, this browser's own overrides when not.
     * Either way the result is the new *effective* settings, so a caller
     * (and `autosave.ts`) cannot tell the two apart and does not have to.
     */
    patchSettings(patch: SettingsPatch): Promise<Result<Settings>>;
    /** Hands one field back to the shared value. */
    clearOverride(field: keyof SettingsOverride): Promise<Result<Settings>>;
    /** Hands every field back at once. */
    clearAllOverrides(): Promise<Result<Settings>>;
    setPlacement(cameraId: string, placement: Placement | null): Promise<Result<Settings>>;
    dispose(): void;
}

export interface CreateSettingsStoreOptions {
    pollIntervalMs?: number;
    /**
     * Whether this device may write to the shared settings. Read at write
     * time, not at construction, so logging in mid-session changes where
     * the next edit lands without rebuilding the store. Injectable for
     * tests; production passes nothing and gets the real session signal.
     */
    loggedIn?: ReadonlySignal<boolean>;
}

export function createSettingsStore(options: CreateSettingsStoreOptions = {}): SettingsStore {
    const pollIntervalMs = options.pollIntervalMs ?? SHARED_STORE_POLL_INTERVAL_MS;
    const loggedIn = options.loggedIn ?? isLoggedIn;

    // `current` is the reactive signal exposed to callers; `state` is the
    // plain, non-reactive mirror this module reads/writes internally via
    // `setState`. Reading `current.get()` from inside the poll's own
    // `effect()` below would subscribe that effect to `current` -- and
    // since that effect's body itself calls `current.set(...)`, every
    // update would immediately re-trigger the same effect, recursing
    // forever (a `merged` object is a new reference every time, so
    // `Signal.set`'s `Object.is` short-circuit never stops it). Reading
    // `state` instead avoids ever creating that cycle.
    let state: Settings = DEFAULT_SETTINGS;
    const current = signal<Settings>(state);
    const pendingFields = new Map<keyof Settings, number>();

    function incrementPending(field: keyof Settings): void {
        pendingFields.set(field, (pendingFields.get(field) ?? 0) + 1);
    }

    /** Decrements the reference count for `field`, only actually clearing the pending mark once it reaches zero. */
    function decrementPending(field: keyof Settings): void {
        const count = pendingFields.get(field) ?? 0;
        if (count <= 1) {
            pendingFields.delete(field);
        } else {
            pendingFields.set(field, count - 1);
        }
    }

    function setState(next: Settings): void {
        state = next;
        current.set(next);
    }

    function mergeServerSnapshot(serverValue: Settings): void {
        if (pendingFields.size === 0) {
            setState(serverValue);
            return;
        }
        const merged: Settings = { ...serverValue };
        for (const field of pendingFields.keys()) {
            (merged as Record<keyof Settings, unknown>)[field] = state[field];
        }
        setState(merged);
    }

    const poll = resource(fetchSettings, { intervalMs: pollIntervalMs });
    const disposePollEffect = effect(() => {
        const pollState = poll.state.get();
        if (pollState.status === 'ready') {
            mergeServerSnapshot(pollState.data);
        } else if (pollState.status === 'error' && pollState.lastData !== undefined) {
            mergeServerSnapshot(pollState.lastData);
        }
    });

    /**
     * Shallow-clones `base` and overwrites exactly `fields`, reading each
     * new value from `source` -- avoids the object-spread-of-a-partial
     * widening every untouched field's type to include `undefined`
     * (`{ ...base, ...partial }` does this even when `partial`'s keys are
     * all actually present at runtime). `source`/the return path work
     * through `Record<string, unknown>` rather than `Partial<Settings>`
     * specifically to sidestep `exactOptionalPropertyTypes`: `SettingsPatch`
     * types its optional fields as `X | undefined` (from Zod's
     * `.optional()`), which `Partial<Settings>` does not accept as an
     * assignable value type under that compiler option, even though every
     * key actually read here came from `Object.keys(source)` and is
     * therefore genuinely present.
     */
    function withFields(base: Settings, fields: (keyof Settings)[], source: Record<string, unknown>): Settings {
        const next = { ...base } as Record<keyof Settings, unknown>;
        for (const field of fields) {
            next[field] = source[field];
        }
        return next as Settings;
    }

    /**
     * The effective settings: the server's values with this device's
     * overrides on top. Recomputed reactively, so clearing an override
     * immediately reveals whatever the shared value currently is.
     */
    const effective: ReadonlySignal<Settings> = computed(() => mergeSettings(current.get(), localOverrides.get()));

    /** Every write resolves with the new *effective* settings, so a caller cannot tell a local write from a shared one. */
    function okEffective(): Result<Settings> {
        return ok(effective.get());
    }

    /**
     * Writes `patch` into this device's own overrides. Used when nobody is
     * logged in: a visitor edits their own copy rather than the one file
     * every other visitor and the kiosk are reading.
     */
    function patchLocally(patch: SettingsPatch): Result<Settings> {
        for (const [field, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            setLocalOverride(field as keyof SettingsOverride, value as NonNullable<SettingsOverride[keyof SettingsOverride]>);
        }
        return okEffective();
    }

    async function patchSettings(patch: SettingsPatch): Promise<Result<Settings>> {
        // Read at write time rather than captured at construction: logging
        // in or out mid-session must change where the *next* edit lands.
        if (!loggedIn.get()) return patchLocally(patch);

        const fields = Object.keys(patch) as (keyof Settings)[];
        const stateAsRecord = state as Record<keyof Settings, unknown>;
        const previousValues: Record<string, unknown> = {};
        for (const field of fields) previousValues[field] = stateAsRecord[field];

        for (const field of fields) incrementPending(field);
        setState(withFields(state, fields, patch));

        function rollback(): void {
            setState(withFields(state, fields, previousValues));
        }

        // Ensures each field's pending reference count is decremented exactly
        // once for this call, regardless of which return/throw path is taken
        // below (the explicit call before `mergeServerSnapshot` on success,
        // and the `finally` block for every other path).
        let released = false;
        function release(): void {
            if (released) return;
            released = true;
            for (const field of fields) decrementPending(field);
        }

        try {
            const response = await fetch('/api/settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(patch),
            });

            if (isUnauthorized(response.status)) {
                rollback();
                logout();
                return err({ message: 'Unauthorized -- the stored password no longer matches the server' });
            }
            if (!response.ok) {
                rollback();
                return err({ message: `PATCH /api/settings responded ${String(response.status)}` });
            }

            const json: unknown = await response.json();
            const parsed = SettingsSchema.safeParse(json);
            if (!parsed.success) {
                rollback();
                return err({ message: 'PATCH /api/settings returned a payload that failed schema validation', cause: parsed.error });
            }

            release();
            mergeServerSnapshot(parsed.data);
            // The shared value for these fields has just been set
            // deliberately, so this device's own override of them is stale
            // intent -- and leaving it would mask the very change that was
            // just made, which reads as the write having failed.
            for (const field of fields) clearLocalOverride(field as keyof SettingsOverride);
            return okEffective();
        } catch (cause) {
            rollback();
            return err({ message: 'Network error while saving settings', cause });
        } finally {
            release();
        }
    }

    async function setPlacement(cameraId: string, placement: Placement | null): Promise<Result<Settings>> {
        const previousPlacements = state.placements;
        const optimisticPlacements: Record<string, Placement> =
            placement === null
                ? Object.fromEntries(Object.entries(previousPlacements).filter(([id]) => id !== cameraId))
                : { ...previousPlacements, [cameraId]: placement };

        incrementPending('placements');
        setState({ ...state, placements: optimisticPlacements });

        function rollback(): void {
            setState({ ...state, placements: previousPlacements });
        }

        // See the matching comment in `patchSettings` -- guards against a
        // double decrement of the same reference count from this call.
        let released = false;
        function release(): void {
            if (released) return;
            released = true;
            decrementPending('placements');
        }

        try {
            const requestInit: RequestInit = {
                method: placement === null ? 'DELETE' : 'PUT',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
            };
            if (placement !== null) requestInit.body = JSON.stringify(placement);
            const response = await fetch(`/api/settings/placements/${encodeURIComponent(cameraId)}`, requestInit);

            if (isUnauthorized(response.status)) {
                rollback();
                logout();
                return err({ message: 'Unauthorized -- the stored password no longer matches the server' });
            }
            if (!response.ok) {
                rollback();
                return err({
                    message: `${placement === null ? 'DELETE' : 'PUT'} /api/settings/placements/${cameraId} responded ${String(response.status)}`,
                });
            }

            const json: unknown = await response.json();
            const parsed = SettingsSchema.safeParse(json);
            if (!parsed.success) {
                rollback();
                return err({ message: 'Placement write returned a payload that failed schema validation', cause: parsed.error });
            }

            release();
            mergeServerSnapshot(parsed.data);
            return ok(parsed.data);
        } catch (cause) {
            rollback();
            return err({ message: 'Network error while saving the camera placement', cause });
        } finally {
            release();
        }
    }

    /**
     * Hands `field` back to the shared value. Async and `Result`-shaped
     * only so it composes with `autosave.ts` and the other write paths --
     * it touches nothing but `localStorage` and cannot fail.
     */
    function clearOverride(field: keyof SettingsOverride): Promise<Result<Settings>> {
        clearLocalOverride(field);
        return Promise.resolve(okEffective());
    }

    function clearAllOverrides(): Promise<Result<Settings>> {
        for (const field of Object.keys(localOverrides.get()) as (keyof SettingsOverride)[]) {
            clearLocalOverride(field);
        }
        return Promise.resolve(okEffective());
    }

    function dispose(): void {
        disposePollEffect();
        poll.dispose();
    }

    return {
        settings: effective,
        serverSettings: current,
        overrides: localOverrides,
        patchSettings,
        clearOverride,
        clearAllOverrides,
        setPlacement,
        dispose,
    };
}
