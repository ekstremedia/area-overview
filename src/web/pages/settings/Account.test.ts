import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        const dispose = mount(container, { store: undefined as never, loggedIn: false });

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
        const dispose = mount(container, { store: undefined as never, loggedIn: true });

        expect(container.querySelector('.settings-account-status')?.textContent).toBe('Innlogget');
        const logoutButton = container.querySelector<HTMLButtonElement>('.settings-account-logout');
        expect(logoutButton?.style.display).not.toBe('none');

        logoutButton?.click();
        expect(session.isLoggedIn.get()).toBe(false);

        dispose();
        vi.unstubAllGlobals();
    });
});
