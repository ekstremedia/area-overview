/**
 * Per-device settings (`theme`, `fontScale`) -- persisted in
 * `localStorage` on the kiosk device itself, never sent to or read from
 * the server (see `DeviceSettingsSchema`'s own doc comment). A module-
 * scope `Signal`, so applying a change (`setDeviceSettings`) is visible
 * everywhere reactively (theme/font-scale application, no reload) without
 * every reader re-parsing `localStorage` itself.
 */
import { DeviceSettingsSchema, type DeviceSettings } from '../shared/schemas/device-settings.js';
import { signal, type Signal } from './core/signal.js';

const STORAGE_KEY = 'area-overview:device-settings';

function readFromStorage(): DeviceSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return DeviceSettingsSchema.parse({});
        const parsed: unknown = JSON.parse(raw);
        const result = DeviceSettingsSchema.safeParse(parsed);
        return result.success ? result.data : DeviceSettingsSchema.parse({});
    } catch {
        // Corrupt JSON, a `localStorage` that throws (private browsing quota
        // edge cases), or anything else unexpected: never throw from here,
        // just fall back to schema defaults.
        return DeviceSettingsSchema.parse({});
    }
}

export const deviceSettings: Signal<DeviceSettings> = signal(readFromStorage());

/** Merges `patch` into the current device settings, validates, persists, and updates the reactive signal. */
export function setDeviceSettings(patch: Partial<DeviceSettings>): void {
    const next = DeviceSettingsSchema.parse({ ...deviceSettings.get(), ...patch });
    deviceSettings.set(next);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // Quota exceeded or storage disabled: the in-memory signal still
        // updated, so the running session behaves correctly; it just won't
        // persist across a reload.
    }
}
