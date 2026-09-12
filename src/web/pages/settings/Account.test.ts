import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSettingsStore } from './test-helpers.js';
import { ok } from '../../../shared/result.js';
import { SettingsSchema, type SettingsOverride } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';

const TEST_PASSWORD = 'a-test-password-used-only-in-this-session';

beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
});

afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
});

describe('Account section', () => {
    it('shows logged-out status, hides the log-out button, and shows the .env note', async () => {
        const { mount } = await import('./Account.js');
        const container = document.createElement('div');
        const dispose = mount(container, { store: fakeSettingsStore(), loggedIn: false });

        expect(container.querySelector('.settings-account-status')?.textContent).toBe('Ikke innlogget');
        expect(container.querySelector<HTMLElement>('.settings-account-logout')?.style.display).toBe('none');
        expect(container.querySelector('.settings-account-note')?.textContent).toContain('.env');

        dispose();
    });

    it('shows logged-in status and a visible log-out button that calls session.logout()', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 204 }));
        const session = await import('../../settings/session.js');
        await session.login(TEST_PASSWORD);
        expect(session.isLoggedIn.get()).toBe(true);

        const { mount } = await import('./Account.js');
        const container = document.createElement('div');
        const dispose = mount(container, { store: fakeSettingsStore(), loggedIn: true });

        expect(container.querySelector('.settings-account-status')?.textContent).toBe('Innlogget');
        const logoutButton = container.querySelector<HTMLButtonElement>('.settings-account-logout');
        expect(logoutButton?.style.display).not.toBe('none');

        logoutButton?.click();
        expect(session.isLoggedIn.get()).toBe(false);

        dispose();
        vi.unstubAllGlobals();
    });
});

describe('Account section -- device overrides', () => {
    it('reads as "no local changes" and is inert on a device following the shared settings', async () => {
        const { mount } = await import('./Account.js');
        const container = document.createElement('div');
        const dispose = mount(container, { store: fakeSettingsStore(), loggedIn: false });

        const button = container.querySelector<HTMLButtonElement>('.settings-account-reset-overrides');
        expect(button?.textContent).toBe('Ingen lokale endringer');
        expect(button?.disabled).toBe(true);

        dispose();
    });

    it('counts the fields this device has taken over', async () => {
        const { mount } = await import('./Account.js');
        const store = fakeSettingsStore({ overrides: signal<SettingsOverride>({ brightness: 40, language: 'en' }) });
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        const button = container.querySelector<HTMLButtonElement>('.settings-account-reset-overrides');
        expect(button?.textContent).toContain('2');
        expect(button?.disabled).toBe(false);

        dispose();
    });

    it('hands every field back at once when pressed', async () => {
        const { mount } = await import('./Account.js');
        const clearAllOverrides = vi.fn(() => Promise.resolve(ok(SettingsSchema.parse({}))));
        const store = fakeSettingsStore({ overrides: signal<SettingsOverride>({ brightness: 40 }), clearAllOverrides });
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        container.querySelector<HTMLButtonElement>('.settings-account-reset-overrides')?.click();

        expect(clearAllOverrides).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('updates the count reactively as overrides come and go', async () => {
        const { mount } = await import('./Account.js');
        // From the same freshly-reset module graph `Account.js` just got:
        // `vi.resetModules()` in `beforeEach` means this file's top-level
        // `signal` import belongs to an older instance of the reactive
        // core, and an effect registered in one instance never sees a
        // signal from the other.
        const { signal: freshSignal } = await import('../../core/signal.js');
        const overrides = freshSignal<SettingsOverride>({});
        const store = fakeSettingsStore({ overrides });
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        overrides.set({ brightness: 40 });

        expect(container.querySelector<HTMLButtonElement>('.settings-account-reset-overrides')?.disabled).toBe(false);

        dispose();
    });
});
