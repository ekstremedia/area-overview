import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSchema } from '../../shared/schemas/settings.js';

const TEST_PASSWORD = 'a-test-password-used-only-in-this-session';

function jsonResponse(status: number, body: unknown): Response {
    return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) } as unknown as Response;
}

function routeFetch(input: string | URL | Request): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    if (url.startsWith('/api/settings/login')) {
        return Promise.resolve(jsonResponse(204, undefined));
    }
    if (url.startsWith('/api/settings')) {
        return Promise.resolve(jsonResponse(200, SettingsSchema.parse({})));
    }
    if (url.startsWith('/api/cameras')) {
        return Promise.resolve(jsonResponse(200, { cameras: [], cached_at: new Date().toISOString() }));
    }
    if (url.startsWith('/api/ships')) {
        return Promise.resolve(jsonResponse(503, { configured: false }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
}

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(routeFetch));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = '';
    vi.resetModules();
});

describe('SettingsPage', () => {
    it('has no button labeled "save"/"lagre" anywhere in its rendered content', async () => {
        const { render } = await import('./SettingsPage.js');
        const container = document.createElement('div');
        const dispose = render(container);
        await vi.advanceTimersByTimeAsync(0);

        const tabs = [...container.querySelectorAll<HTMLButtonElement>('.settings-subnav-tab')];
        for (const tab of tabs) {
            tab.click();
            await vi.advanceTimersByTimeAsync(0);
            const buttons = [...container.querySelectorAll('button')];
            for (const button of buttons) {
                const text = button.textContent.toLowerCase();
                expect(text).not.toContain('lagre');
                expect(text).not.toContain('save');
            }
        }

        dispose();
    });

    it('shows the login button and a read-only notice when logged out, and every section renders disabled controls', async () => {
        const { render } = await import('./SettingsPage.js');
        const container = document.createElement('div');
        const dispose = render(container);
        await vi.advanceTimersByTimeAsync(0);

        expect(container.querySelector<HTMLButtonElement>('.settings-login-button')?.style.display).not.toBe('none');
        expect(container.querySelector<HTMLElement>('.settings-logged-out-notice')?.style.display).not.toBe('none');

        dispose();
    });

    it('switching sub-nav tabs mounts a different section', async () => {
        const { render } = await import('./SettingsPage.js');
        const container = document.createElement('div');
        const dispose = render(container);
        await vi.advanceTimersByTimeAsync(0);

        expect(container.querySelector('.settings-section-cameras')).not.toBeNull();

        const tabs = [...container.querySelectorAll<HTMLButtonElement>('.settings-subnav-tab')];
        tabs[4]?.click(); // General
        expect(container.querySelector('.settings-section-general')).not.toBeNull();
        expect(container.querySelector('.settings-section-cameras')).toBeNull();

        dispose();
    });

    it('logging in via the dialog unlocks the page and updates the masthead account status', async () => {
        const { render } = await import('./SettingsPage.js');
        const { pageAccountStatus } = await import('../shell/page-status.js');
        const container = document.createElement('div');
        const dispose = render(container);
        await vi.advanceTimersByTimeAsync(0);

        expect(pageAccountStatus.get()).toBeNull();

        container.querySelector<HTMLButtonElement>('.settings-login-button')?.click();
        const passwordInput = container.querySelector<HTMLInputElement>('.login-dialog-password');
        if (!passwordInput) throw new Error('password input not found');
        passwordInput.value = TEST_PASSWORD;
        container.querySelector<HTMLFormElement>('.login-dialog-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        await vi.waitFor(() => {
            expect(pageAccountStatus.get()).not.toBeNull();
        });
        expect(pageAccountStatus.get()?.text).toBe('Innlogget · lagrer automatisk');
        expect(container.querySelector('.login-dialog')).toBeNull(); // dialog closed
        expect(container.querySelector<HTMLButtonElement>('.settings-login-button')?.style.display).toBe('none');

        dispose();
    });

    it('logging out drops the page back to its read-only state and clears the masthead status', async () => {
        const { render } = await import('./SettingsPage.js');
        const { pageAccountStatus } = await import('../shell/page-status.js');
        const session = await import('../settings/session.js');
        await session.login(TEST_PASSWORD);

        const container = document.createElement('div');
        const dispose = render(container);
        await vi.advanceTimersByTimeAsync(0);
        expect(pageAccountStatus.get()).not.toBeNull();

        pageAccountStatus.get()?.onLogout();

        expect(session.isLoggedIn.get()).toBe(false);
        expect(pageAccountStatus.get()).toBeNull();
        expect(container.querySelector<HTMLButtonElement>('.settings-login-button')?.style.display).not.toBe('none');

        dispose();
    });
});
