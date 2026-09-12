/**
 * A `SettingsStore` double for the settings-section tests.
 *
 * Exists so that adding a method to the store doesn't mean editing five
 * test files that never cared about it: each section test overrides only
 * the two or three members it actually exercises, and everything else
 * behaves plausibly rather than being `undefined`.
 */
import { vi } from 'vitest';
import { ok } from '../../../shared/result.js';
import { SettingsSchema, type Settings, type SettingsOverride } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import type { SettingsStore } from '../../settings/sharedStore.js';

export function fakeSettingsStore(overrides: Partial<SettingsStore> = {}): SettingsStore {
    const settings = overrides.settings ?? signal<Settings>(SettingsSchema.parse({}));
    return {
        settings,
        // Defaults to the same signal as `settings`: a test that doesn't
        // care about device overrides is a test where the effective and
        // shared values are the same thing.
        serverSettings: settings,
        overrides: signal<SettingsOverride>({}),
        patchSettings: vi.fn(() => Promise.resolve(ok(settings.get()))),
        clearOverride: vi.fn(() => Promise.resolve(ok(settings.get()))),
        clearAllOverrides: vi.fn(() => Promise.resolve(ok(settings.get()))),
        setPlacement: vi.fn(() => Promise.resolve(ok(settings.get()))),
        dispose: vi.fn(),
        ...overrides,
    };
}
