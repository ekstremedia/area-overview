/**
 * Account section (artboard 07's "Konto"): logged-in state, a "Logg ut"/
 * "Log out" button, and a static, translated one-line note that the
 * shared password lives in the server's `.env` -- no value or file path
 * exposed here, just the fact of where it's kept.
 */
import { overriddenFields } from '../../../shared/settings-merge.js';
import { effect } from '../../core/signal.js';
import { formatNumber, t } from '../../i18n/index.js';
import { isLoggedIn, logout } from '../../settings/session.js';
import type { SectionMount } from './sectionContext.js';

export const mount: SectionMount = (container, ctx) => {
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

    // The one place that undoes every device-local change at once, for
    // whoever has ended up with a browser that no longer resembles the
    // shared settings and would rather start over than hunt down which
    // rows they changed.
    const resetOverridesButton = document.createElement('button');
    resetOverridesButton.type = 'button';
    resetOverridesButton.className = 'settings-account-reset-overrides';
    resetOverridesButton.addEventListener('click', () => {
        void ctx.store.clearAllOverrides();
    });

    const resetOverridesNote = document.createElement('div');
    resetOverridesNote.className = 'settings-account-note';
    resetOverridesNote.textContent = t('settings.override.resetAllNote');

    root.append(statusEl, logoutButton, note, resetOverridesButton, resetOverridesNote);
    container.append(root);

    const disposeEffect = effect(() => {
        const loggedIn = isLoggedIn.get();
        statusEl.textContent = loggedIn ? t('settings.account.loggedIn') : t('settings.account.loggedOut');
        logoutButton.style.display = loggedIn ? '' : 'none';
    });

    const disposeOverridesEffect = effect(() => {
        const count = overriddenFields(ctx.store.overrides.get()).length;
        resetOverridesButton.textContent =
            count === 0 ? t('settings.override.resetAllNone') : t('settings.override.resetAll', { count: formatNumber(count) });
        // Left visible but inert at zero rather than hidden: it is also
        // the answer to "has this device changed anything?", which is
        // worth being able to read at a glance.
        resetOverridesButton.disabled = count === 0;
        resetOverridesNote.hidden = count === 0;
    });

    return function dispose(): void {
        disposeEffect();
        disposeOverridesEffect();
        root.remove();
    };
};
