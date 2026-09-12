/**
 * The settings this device has chosen for itself, laid over the shared
 * server settings for this browser alone.
 *
 * Same shape and the same defensive handling as `device-settings.ts`
 * (which holds `theme`/`fontScale`/`basemap`), and kept separate from it
 * on purpose: those three have no shared counterpart at all, while every
 * field here *shadows* a real server setting and can be handed back to it.
 *
 * Never sent to the server. A visitor's chosen position in particular is
 * personal, and this module is the only thing that persists it -- see
 * `src/web/geolocation.ts` for the rounding it goes through first.
 */
import { SettingsOverrideSchema, type SettingsOverride } from '../../shared/schemas/settings.js';
import { signal, type ReadonlySignal } from '../core/signal.js';

const STORAGE_KEY = 'area-overview:settings-overrides';

function readFromStorage(): SettingsOverride {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return {};
        const parsed: unknown = JSON.parse(raw);
        const result = SettingsOverrideSchema.safeParse(parsed);
        // A whole-object parse, so a single stale key left behind by a
        // renamed setting costs the lot rather than poisoning the merge.
        // Losing a device's overrides is recoverable in one tap; serving a
        // half-validated settings object is not.
        return result.success ? result.data : {};
    } catch {
        // Corrupt JSON, or a `localStorage` that throws outright (private
        // browsing, storage disabled): never throw from here.
        return {};
    }
}

const overrides = signal<SettingsOverride>(readFromStorage());

/** Reactive, so anything reading merged settings re-renders the moment a device override changes. */
export const localOverrides: ReadonlySignal<SettingsOverride> = overrides;

function persist(next: SettingsOverride): void {
    overrides.set(next);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // Quota exceeded or storage disabled: the in-memory signal still
        // updated, so this session behaves correctly; it just won't survive
        // a reload.
    }
}

/** Overrides one field on this device. The value is validated against the same schema a `PATCH` of that field would be. */
export function setLocalOverride<K extends keyof SettingsOverride>(field: K, value: NonNullable<SettingsOverride[K]>): void {
    const candidate = { ...overrides.get(), [field]: value };
    const parsed = SettingsOverrideSchema.safeParse(candidate);
    // A value that would be rejected by the server is rejected here too,
    // rather than being persisted locally where nothing would ever catch
    // it: the two paths must not disagree about what is a legal setting.
    if (!parsed.success) return;
    persist(parsed.data);
}

/** Hands one field back to the shared value. */
export function clearLocalOverride(field: keyof SettingsOverride): void {
    const current = overrides.get();
    if (current[field] === undefined) return;
    // Rebuilt without the key rather than having it deleted: an
    // own-but-undefined key would survive `JSON.stringify` as an absent
    // key anyway, but would read as present to anything iterating the
    // object in this session.
    const next = Object.fromEntries(Object.entries(current).filter(([key]) => key !== field)) as SettingsOverride;
    persist(next);
}

/** Hands every field back to the shared values -- the "this device follows the shared settings again" button. */
export function clearAllLocalOverrides(): void {
    persist({});
}
