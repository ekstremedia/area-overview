/**
 * The login overlay (artboard 08): the settings page dims under an ink
 * veil while this is open. One shared password, typed via the physical
 * keyboard or (on the kiosk) `OnScreenKeyboard.ts` -- the password field
 * is a plain `<input type="password">` (toggleable to `type="text"` via
 * "Vis"/"Show", a normal, expected UX pattern), so it's picked up by the
 * on-screen keyboard's own focus-tracking with no special-casing needed
 * there.
 *
 * On success: calls `options.onSuccess()` and the caller (`SettingsPage`)
 * closes the dialog. On a wrong password: shows the localized error text
 * in the error color, keeps the dialog open, and deliberately does NOT
 * clear the typed password -- so a typo is visible and correctable
 * rather than requiring a full retype.
 *
 * Never logs or exposes the typed password anywhere except the field
 * itself and the one `Authorization` header `session.login()` sends.
 */
import { login } from '../settings/session.js';
import { t } from '../i18n/index.js';
import './LoginDialog.css';

export interface LoginDialogOptions {
    onSuccess: () => void;
}

export interface LoginDialogHandle {
    el: HTMLElement;
    dispose: () => void;
}

export function mountLoginDialog(container: HTMLElement, options: LoginDialogOptions): LoginDialogHandle {
    const root = document.createElement('div');
    root.className = 'login-dialog';

    const veil = document.createElement('div');
    veil.className = 'login-dialog-veil';

    const panel = document.createElement('div');
    panel.className = 'login-dialog-panel';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'login-dialog-eyebrow';
    eyebrow.textContent = t('login.requiresPassword');

    const heading = document.createElement('div');
    heading.className = 'login-dialog-heading';
    heading.textContent = t('login.title');

    const description = document.createElement('div');
    description.className = 'login-dialog-description';
    description.textContent = t('login.description');

    const form = document.createElement('form');
    form.className = 'login-dialog-form';
    form.noValidate = true;

    const fieldRow = document.createElement('div');
    fieldRow.className = 'login-dialog-field-row';

    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.className = 'login-dialog-password';
    passwordInput.id = 'login-dialog-password';
    passwordInput.name = 'login-dialog-password';
    passwordInput.autocomplete = 'off';
    passwordInput.setAttribute('aria-label', t('login.title'));

    const showToggle = document.createElement('button');
    showToggle.type = 'button';
    showToggle.className = 'login-dialog-show-toggle';
    showToggle.textContent = t('login.show');
    let revealed = false;
    showToggle.addEventListener('click', () => {
        revealed = !revealed;
        passwordInput.type = revealed ? 'text' : 'password';
        showToggle.textContent = revealed ? t('login.hideValue') : t('login.show');
    });

    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'login-dialog-field';
    fieldWrap.append(passwordInput, showToggle);

    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'login-dialog-submit';
    submitButton.textContent = t('login.submit');

    fieldRow.append(fieldWrap, submitButton);

    const errorEl = document.createElement('div');
    errorEl.className = 'login-dialog-error';

    form.append(fieldRow, errorEl);
    panel.append(eyebrow, heading, description, form);
    root.append(veil, panel);
    container.append(root);

    let submitting = false;

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (submitting) return;
        const password = passwordInput.value;
        if (password.length === 0) return;

        submitting = true;
        submitButton.disabled = true;

        void login(password).then((result) => {
            submitting = false;
            submitButton.disabled = false;
            if (result.ok) {
                errorEl.textContent = '';
                options.onSuccess();
            } else {
                errorEl.textContent = t('login.error');
                // Deliberately not clearing `passwordInput.value` -- see
                // this module's doc comment.
            }
        });
    });

    function dispose(): void {
        root.remove();
    }

    return { el: root, dispose };
}
