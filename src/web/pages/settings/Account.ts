/**
 * Account section (artboard 07's "Konto"): logged-in state, a "Logg ut"/
 * "Log out" button, and a static, translated one-line note that the
 * shared password lives in the server's `.env` -- no value or file path
 * exposed here, just the fact of where it's kept.
 */
import { effect } from '../../core/signal.js';
import { t } from '../../i18n/index.js';
import { isLoggedIn, logout } from '../../settings/session.js';
import type { SectionMount } from './sectionContext.js';

export const mount: SectionMount = (container) => {
    const root = document.createElement('div');
    root.className = 'settings-section-account';

    const statusEl = document.createElement('div');
    statusEl.className = 'settings-account-status';

    const logoutButton = document.createElement('button');
    logoutButton.type = 'button';
    logoutButton.className = 'settings-account-logout';
    logoutButton.textContent = t('settings.logOut');
    logoutButton.addEventListener('click', () => {
        logout();
    });

    const note = document.createElement('div');
    note.className = 'settings-account-note';
    note.textContent = t('settings.account.passwordNote');

    root.append(statusEl, logoutButton, note);
    container.append(root);

    const disposeEffect = effect(() => {
        const loggedIn = isLoggedIn.get();
        statusEl.textContent = loggedIn ? t('settings.account.loggedIn') : t('settings.account.loggedOut');
        logoutButton.style.display = loggedIn ? '' : 'none';
    });

    return function dispose(): void {
        disposeEffect();
        root.remove();
    };
};
