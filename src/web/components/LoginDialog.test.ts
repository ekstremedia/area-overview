import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../shared/result.js';

const loginMock = vi.fn();
vi.mock('../settings/session.js', () => ({ login: loginMock }));

const { mountLoginDialog } = await import('./LoginDialog.js');

const TEST_PASSWORD = 'a-test-password-used-only-in-this-session';

beforeEach(() => {
    loginMock.mockReset();
});

afterEach(() => {
    document.body.innerHTML = '';
});

function submit(form: HTMLFormElement): void {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function getPasswordInput(el: HTMLElement): HTMLInputElement {
    const input = el.querySelector<HTMLInputElement>('.login-dialog-password');
    if (!input) throw new Error('password input not found');
    return input;
}

function getForm(el: HTMLElement): HTMLFormElement {
    const form = el.querySelector<HTMLFormElement>('.login-dialog-form');
    if (!form) throw new Error('form not found');
    return form;
}

function typeAndSubmit(el: HTMLElement, password: string): void {
    getPasswordInput(el).value = password;
    submit(getForm(el));
}

describe('mountLoginDialog', () => {
    it('renders the password field masked by default, with a Vis/Skjul toggle', () => {
        const container = document.createElement('div');
        const { el } = mountLoginDialog(container, { onSuccess: vi.fn() });

        const input = getPasswordInput(el);
        expect(input.type).toBe('password');

        const toggle = el.querySelector<HTMLButtonElement>('.login-dialog-show-toggle');
        expect(toggle?.textContent).toBe('Vis');
        toggle?.click();
        expect(input.type).toBe('text');
        expect(toggle?.textContent).toBe('Skjul');
    });

    it('calls session.login() with the typed password and onSuccess() on a successful login', async () => {
        loginMock.mockResolvedValue(ok(undefined));
        const onSuccess = vi.fn();
        const container = document.createElement('div');
        const { el } = mountLoginDialog(container, { onSuccess });

        typeAndSubmit(el, TEST_PASSWORD);

        await vi.waitFor(() => {
            expect(onSuccess).toHaveBeenCalledTimes(1);
        });
        expect(loginMock).toHaveBeenCalledWith(TEST_PASSWORD);
    });

    it('shows the wrong-password message, keeps the dialog open, and does not clear the typed password on a 401', async () => {
        loginMock.mockResolvedValue(err({ message: 'Wrong password' }));
        const onSuccess = vi.fn();
        const container = document.createElement('div');
        const { el } = mountLoginDialog(container, { onSuccess });

        typeAndSubmit(el, 'wrong-password-also-fake');

        await vi.waitFor(() => {
            expect(el.querySelector('.login-dialog-error')?.textContent).toBe('Feil passord. Prøv igjen.');
        });
        expect(onSuccess).not.toHaveBeenCalled();
        expect(getPasswordInput(el).value).toBe('wrong-password-also-fake'); // not cleared
        expect(container.contains(el)).toBe(true); // dialog still mounted/open
    });

    it('never logs the password anywhere it does not belong (no console output touches it)', async () => {
        loginMock.mockResolvedValue(ok(undefined));
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const container = document.createElement('div');
        const { el } = mountLoginDialog(container, { onSuccess: vi.fn() });

        typeAndSubmit(el, TEST_PASSWORD);

        await vi.waitFor(() => {
            expect(loginMock).toHaveBeenCalled();
        });
        for (const call of consoleSpy.mock.calls) {
            expect(call.join(' ')).not.toContain(TEST_PASSWORD);
        }
        consoleSpy.mockRestore();
    });

    it('dispose() removes the dialog from the DOM', () => {
        const container = document.createElement('div');
        const handle = mountLoginDialog(container, { onSuccess: vi.fn() });

        expect(container.contains(handle.el)).toBe(true);
        handle.dispose();
        expect(container.contains(handle.el)).toBe(false);
    });
});
