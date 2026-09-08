/**
 * The settings page (artboards 07/08): a section sub-nav (Kameraer, Kart,
 * Visning, Lag, Generelt, Konto), autosave everywhere, no save button
 * anywhere. Every shared-setting control renders read-only while logged
 * out, with one prominent "Logg inn" button opening `LoginDialog`; device
 * settings (theme, font scale, inside the Visning section) stay editable
 * regardless of login state.
 *
 * Deliberately does NOT redesign the shared masthead's brand/tab row for
 * this route (Phase 5 kept one masthead for every route, including this
 * one) -- the section sub-nav below is this page's own content, and the
 * login/logout status text is contributed through `pageAccountStatus`
 * (the same page-supplied-status extension point `liveLayerCounts` uses).
 *
 * `createSettingsStore()` and `mountOnScreenKeyboard()` are created fresh
 * per mount and disposed per unmount, same lifecycle as every other
 * page's own `resource()` instances -- nothing here is a module-scope
 * singleton.
 */
import { effect } from '../core/signal.js';
import { mountLoginDialog, type LoginDialogHandle } from '../components/LoginDialog.js';
import { mountOnScreenKeyboard } from '../components/OnScreenKeyboard.js';
import { t, type ParamlessKey } from '../i18n/index.js';
import { claimPageStatus, pageAccountStatus } from '../shell/page-status.js';
import { isLoggedIn, logout } from '../settings/session.js';
import { createSettingsStore } from '../settings/sharedStore.js';
import * as AccountSection from './settings/Account.js';
import * as CamerasSection from './settings/Cameras.js';
import * as DisplaySection from './settings/Display.js';
import * as GeneralSection from './settings/General.js';
import * as LayersSection from './settings/Layers.js';
import * as MapSection from './settings/Map.js';
import type { SectionMount } from './settings/sectionContext.js';
import './settings/settings.css';

type SectionId = 'cameras' | 'map' | 'display' | 'layers' | 'general' | 'account';

interface SectionDescriptor {
    id: SectionId;
    navKey: ParamlessKey;
    mount: SectionMount;
}

const SECTIONS: readonly SectionDescriptor[] = [
    { id: 'cameras', navKey: 'settings.section.cameras', mount: CamerasSection.mount },
    { id: 'map', navKey: 'settings.section.map', mount: MapSection.mount },
    { id: 'display', navKey: 'settings.section.display', mount: DisplaySection.mount },
    { id: 'layers', navKey: 'settings.section.layers', mount: LayersSection.mount },
    { id: 'general', navKey: 'settings.section.general', mount: GeneralSection.mount },
    { id: 'account', navKey: 'settings.section.account', mount: AccountSection.mount },
];

export function render(container: HTMLElement): () => void {
    const releaseStatus = claimPageStatus();

    const wrapper = document.createElement('div');
    wrapper.className = 'settings-page';

    const nav = document.createElement('nav');
    nav.className = 'settings-subnav';

    const loggedOutNotice = document.createElement('div');
    loggedOutNotice.className = 'settings-logged-out-notice';

    const loginButton = document.createElement('button');
    loginButton.type = 'button';
    loginButton.className = 'settings-login-button';

    const sectionContainer = document.createElement('div');
    sectionContainer.className = 'settings-section-container';

    // The nav is a column down the left (artboard 07), so everything else
    // shares one scrolling area beside it rather than stacking under it.
    const main = document.createElement('div');
    main.className = 'settings-main';
    main.append(loggedOutNotice, loginButton, sectionContainer);

    wrapper.append(nav, main);
    container.append(wrapper);

    const store = createSettingsStore();
    const keyboard = mountOnScreenKeyboard(wrapper);

    let activeSectionId: SectionId = 'cameras';
    let disposeSection: (() => void) | undefined;
    let loginDialog: LoginDialogHandle | undefined;
    let disposed = false;

    const tabButtons = SECTIONS.map((section) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-subnav-tab';
        button.addEventListener('click', () => {
            switchSection(section.id);
        });
        nav.append(button);
        return { section, button };
    });

    function renderTabs(): void {
        for (const { section, button } of tabButtons) {
            button.textContent = t(section.navKey);
            button.classList.toggle('settings-subnav-tab--active', section.id === activeSectionId);
        }
    }

    function mountActiveSection(): void {
        disposeSection?.();
        sectionContainer.innerHTML = '';
        const descriptor = SECTIONS.find((section) => section.id === activeSectionId);
        if (!descriptor) return;
        disposeSection = descriptor.mount(sectionContainer, { store, loggedIn: isLoggedIn.get() });
    }

    function switchSection(id: SectionId): void {
        activeSectionId = id;
        renderTabs();
        mountActiveSection();
    }

    function openLoginDialog(): void {
        if (loginDialog) return;
        loginDialog = mountLoginDialog(wrapper, {
            onSuccess: () => {
                loginDialog?.dispose();
                loginDialog = undefined;
            },
        });
    }

    loginButton.addEventListener('click', openLoginDialog);

    // Re-render the tab labels reactively too -- `t()`'s own reactivity
    // (via `currentLanguage`) is otherwise only picked up by whatever's
    // inside an `effect()`, and a bare `renderTabs()` call is not one.
    const disposeTabsEffect = effect(() => {
        renderTabs();
    });

    const disposeLoginStateEffect = effect(() => {
        const loggedIn = isLoggedIn.get();
        loggedOutNotice.style.display = loggedIn ? 'none' : '';
        loggedOutNotice.textContent = t('settings.loggedOutNotice');
        loginButton.style.display = loggedIn ? 'none' : '';
        loginButton.textContent = t('settings.logIn');
        if (loggedIn) {
            loginDialog?.dispose();
            loginDialog = undefined;
        }
        // `mountActiveSection()` must run OUTSIDE this effect's own tracked
        // synchronous execution. This project's signal tracking (see
        // `signal.ts`'s `runTracked`/`activeTracker`) attributes ANY signal
        // read during a tracked callback's synchronous run to that effect,
        // no matter how many function calls deep -- and some section
        // `mount()`s (`Display.ts`, `Map.ts`) read `store.settings`/
        // `deviceSettings` synchronously at the top of their own `mount()`,
        // outside of their own nested `effect()`. Calling `mountActiveSection`
        // directly here would silently subscribe THIS login-state effect to
        // every shared/device setting too, so an unrelated change elsewhere
        // (e.g. another device changing brightness) would re-run this
        // effect and tear down/remount the active section mid-edit.
        // `queueMicrotask` defers the call until after this effect's
        // synchronous body -- and `runTracked`'s `activeTracker` restore --
        // has already completed, so those reads are correctly untracked
        // (or attributed only to whatever effect the section itself creates
        // internally, as `Cameras.ts` already does correctly).
        queueMicrotask(() => {
            if (!disposed) mountActiveSection();
        });
    });

    const disposeAccountStatusEffect = effect(() => {
        if (isLoggedIn.get()) {
            pageAccountStatus.set({
                text: t('settings.loggedInStatus'),
                logoutLabel: t('settings.logOut'),
                onLogout: () => {
                    logout();
                },
            });
        } else {
            pageAccountStatus.set(null);
        }
    });

    return function dispose(): void {
        disposed = true;
        disposeAccountStatusEffect();
        releaseStatus();
        disposeLoginStateEffect();
        disposeTabsEffect();
        disposeSection?.();
        loginDialog?.dispose();
        keyboard.dispose();
        store.dispose();
        loginButton.removeEventListener('click', openLoginDialog);
        wrapper.remove();
    };
}
