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
 */
import { err, ok, type Result } from '../../shared/result.js';
import { SettingsSchema, type Placement, type Settings, type SettingsPatch } from '../../shared/schemas/settings.js';
import { resource } from '../core/resource.js';
import { effect, signal, type ReadonlySignal } from '../core/signal.js';
import { authHeaders, logout } from './session.js';

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
    settings: ReadonlySignal<Settings>;
    patchSettings(patch: SettingsPatch): Promise<Result<Settings>>;
    setPlacement(cameraId: string, placement: Placement | null): Promise<Result<Settings>>;
    dispose(): void;
}

export interface CreateSettingsStoreOptions {
    pollIntervalMs?: number;
}

export function createSettingsStore(options: CreateSettingsStoreOptions = {}): SettingsStore {
    const pollIntervalMs = options.pollIntervalMs ?? SHARED_STORE_POLL_INTERVAL_MS;

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
    const pendingFields = new Set<keyof Settings>();

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
        for (const field of pendingFields) {
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

    async function patchSettings(patch: SettingsPatch): Promise<Result<Settings>> {
        const fields = Object.keys(patch) as (keyof Settings)[];
        const stateAsRecord = state as Record<keyof Settings, unknown>;
        const previousValues: Record<string, unknown> = {};
        for (const field of fields) previousValues[field] = stateAsRecord[field];

        for (const field of fields) pendingFields.add(field);
        setState(withFields(state, fields, patch));

        function rollback(): void {
            setState(withFields(state, fields, previousValues));
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

            for (const field of fields) pendingFields.delete(field);
            mergeServerSnapshot(parsed.data);
            return ok(parsed.data);
        } catch (cause) {
            rollback();
            return err({ message: 'Network error while saving settings', cause });
        } finally {
            for (const field of fields) pendingFields.delete(field);
        }
    }

    async function setPlacement(cameraId: string, placement: Placement | null): Promise<Result<Settings>> {
        const previousPlacements = state.placements;
        const optimisticPlacements: Record<string, Placement> =
            placement === null
                ? Object.fromEntries(Object.entries(previousPlacements).filter(([id]) => id !== cameraId))
                : { ...previousPlacements, [cameraId]: placement };

        pendingFields.add('placements');
        setState({ ...state, placements: optimisticPlacements });

        function rollback(): void {
            setState({ ...state, placements: previousPlacements });
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

            pendingFields.delete('placements');
            mergeServerSnapshot(parsed.data);
            return ok(parsed.data);
        } catch (cause) {
            rollback();
            return err({ message: 'Network error while saving the camera placement', cause });
        } finally {
            pendingFields.delete('placements');
        }
    }

    function dispose(): void {
        disposePollEffect();
        poll.dispose();
    }

    return { settings: current, patchSettings, setPlacement, dispose };
}
