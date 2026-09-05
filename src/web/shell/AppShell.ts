/**
 * The frame every page lives in: masthead, the active page, footer line.
 * Masthead and footer mount once, for the app's lifetime. The active
 * page is re-mounted on every `currentRoute` change by a single
 * top-level `effect()` created once here (never recreated per
 * navigation) -- the effect disposes the *previous* page before mounting
 * the next one, which is the single most safety-critical behavior in
 * this module: a page's `render()` may start `effect()`s/timers of its
 * own, and skipping this disposal leaks one per navigation, for the
 * lifetime of a kiosk that runs for weeks. See
 * `router-integration.test.ts` for the test that actually proves this,
 * not just documents it.
 */
import { currentRoute } from '../core/router.js';
import { effect } from '../core/signal.js';
import { pageForRoute } from '../pages/registry.js';
import { mountFooterLine } from './FooterLine.js';
import { mountMasthead } from './Masthead.js';

export function mountAppShell(root: HTMLElement): () => void {
    root.innerHTML = '';

    const mastheadContainer = document.createElement('header');
    const pageContainer = document.createElement('main');
    pageContainer.className = 'page';
    const footerContainer = document.createElement('footer');

    root.append(mastheadContainer, pageContainer, footerContainer);

    const disposeMasthead = mountMasthead(mastheadContainer);
    const disposeFooter = mountFooterLine(footerContainer);

    let disposePage: (() => void) | undefined;

    const disposeRouteEffect = effect(() => {
        const route = currentRoute.get();
        disposePage?.();
        pageContainer.innerHTML = '';
        disposePage = pageForRoute(route).render(pageContainer);
    });

    return function dispose(): void {
        disposeRouteEffect();
        disposePage?.();
        disposeMasthead();
        disposeFooter();
        root.innerHTML = '';
    };
}
