import { describe, expect, it, vi } from 'vitest';
import { ok } from '../../../shared/result.js';
import { SettingsSchema, type SettingsOverride } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import { field, overrideFor } from './field.js';
import { fakeSettingsStore } from './test-helpers.js';

function control(): HTMLElement {
    return document.createElement('input');
}

describe('field', () => {
    it('renders a label and the control', () => {
        const handle = field({ label: 'Lysstyrke', control: control() });

        expect(handle.el.querySelector('.settings-field-label')?.textContent).toBe('Lysstyrke');
        expect(handle.el.querySelector('input')).not.toBeNull();

        handle.dispose();
    });

    it('points the label at the control when given an input id', () => {
        const input = control();
        input.id = 'settings-brightness';

        const handle = field({ label: 'Lysstyrke', control: input, inputId: 'settings-brightness' });

        expect(handle.el.querySelector<HTMLLabelElement>('label')?.htmlFor).toBe('settings-brightness');
        handle.dispose();
    });

    it('grows no badge at all for a field no device can override', () => {
        const handle = field({ label: 'Kameraplassering', control: control() });

        expect(handle.el.querySelector('.settings-field-override')).toBeNull();
        handle.dispose();
    });

    it('hides the badge while the field follows the shared value', () => {
        const handle = field({
            label: 'Lysstyrke',
            control: control(),
            override: { isOverridden: () => false, sharedText: () => '100 %', onUseShared: vi.fn() },
        });

        expect(handle.el.querySelector<HTMLElement>('.settings-field-override')?.hidden).toBe(true);
        handle.dispose();
    });

    it('shows the badge and the shared value once the device takes the field over', () => {
        const overridden = signal(false);
        const handle = field({
            label: 'Lysstyrke',
            control: control(),
            override: { isOverridden: () => overridden.get(), sharedText: () => '100 %', onUseShared: vi.fn() },
        });

        overridden.set(true);

        const note = handle.el.querySelector<HTMLElement>('.settings-field-override');
        expect(note?.hidden).toBe(false);
        expect(handle.el.querySelector('.settings-field-override-badge')?.textContent).toBe('Bare denne enheten');
        // The hint names the value the button would give, so it never
        // looks like a no-op.
        expect(handle.el.querySelector('.settings-field-override-reset')?.textContent).toContain('100 %');

        handle.dispose();
    });

    it('keeps the row at a constant height rather than removing the badge, so a list does not jump under a finger', () => {
        const overridden = signal(true);
        const handle = field({
            label: 'Lysstyrke',
            control: control(),
            override: { isOverridden: () => overridden.get(), sharedText: () => '100 %', onUseShared: vi.fn() },
        });

        overridden.set(false);

        // Still in the DOM, just hidden.
        expect(handle.el.querySelector('.settings-field-override')).not.toBeNull();
        handle.dispose();
    });

    it('hands the field back when the button is pressed', () => {
        const onUseShared = vi.fn();
        const handle = field({
            label: 'Lysstyrke',
            control: control(),
            override: { isOverridden: () => true, sharedText: () => '100 %', onUseShared },
        });

        handle.el.querySelector<HTMLButtonElement>('.settings-field-override-reset')?.click();

        expect(onUseShared).toHaveBeenCalledTimes(1);
        handle.dispose();
    });

    it('stops tracking when disposed', () => {
        const overridden = signal(false);
        const isOverridden = vi.fn(() => overridden.get());
        const handle = field({
            label: 'Lysstyrke',
            control: control(),
            override: { isOverridden, sharedText: () => '100 %', onUseShared: vi.fn() },
        });
        handle.dispose();
        const callsAtDispose = isOverridden.mock.calls.length;

        overridden.set(true);

        expect(isOverridden.mock.calls.length).toBe(callsAtDispose);
    });
});

describe('overrideFor', () => {
    it('is not overridden while this device holds no value for the field', () => {
        const store = fakeSettingsStore();

        expect(overrideFor(store, 'brightness', String).isOverridden()).toBe(false);
    });

    it('is overridden once this device holds a value for it', () => {
        const overrides = signal<SettingsOverride>({ brightness: 40 });
        const store = fakeSettingsStore({ overrides });

        expect(overrideFor(store, 'brightness', String).isOverridden()).toBe(true);
    });

    it('formats the shared value, not the effective one -- showing what you already have would look like a no-op', () => {
        const store = fakeSettingsStore({
            settings: signal(SettingsSchema.parse({ brightness: 40 })),
            serverSettings: signal(SettingsSchema.parse({ brightness: 100 })),
            overrides: signal<SettingsOverride>({ brightness: 40 }),
        });

        expect(overrideFor(store, 'brightness', (shared) => `${String(shared)} %`).sharedText()).toBe('100 %');
    });

    it('clears exactly that field when handed back', () => {
        // Held as a local rather than read back off the store, so the
        // assertion isn't an unbound method reference.
        const clearOverride = vi.fn(() => Promise.resolve(ok(SettingsSchema.parse({}))));
        const store = fakeSettingsStore({ clearOverride });

        overrideFor(store, 'brightness', String).onUseShared();

        expect(clearOverride).toHaveBeenCalledWith('brightness');
    });
});
