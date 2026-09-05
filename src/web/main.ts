/**
 * Frontend entry point: applies device settings (theme, font scale)
 * before mounting anything, starts the router (imported for its side
 * effect -- see `core/router.ts`), mounts the app shell, the night/
 * brightness overlay, and idle-reset.
 */
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './shell/shell.css';
import './components/components.css';

import './core/router.js'; // side effect: starts listening for hashchange and seeds `currentRoute`

import { mountAppShell } from './shell/AppShell.js';
import { mountDisplayOverlay } from './shell/DisplayOverlay.js';
import { startFontScaleApplication, startThemeApplication } from './shell/theme.js';
import { startIdleReset } from './shell/idle.js';
import { effect } from './core/signal.js';
import { currentLanguage } from './i18n/index.js';

startThemeApplication();
startFontScaleApplication();
effect(() => {
    document.documentElement.lang = currentLanguage.get();
});

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
    mountAppShell(app);
}

mountDisplayOverlay();
startIdleReset();
