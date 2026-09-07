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
 *
 * Auto-cycle (`autoCycle.ts`'s timer) uses a SEPARATE path, `cycleTo()`
 * below, instead of this plain effect: it mounts the incoming page into
 * its own hidden container while the outgoing page is still fully on
 * screen (so the incoming page gets a head start fetching/rendering),
 * waits a fixed pre-warm delay, then runs a CSS slide transition between
 * the two containers before disposing the outgoing page and settling
 * back to the normal single-container steady state. `location.hash` is
 * updated partway through `cycleTo()` (see its own comment for exactly
 * when and why), which fires the plain route effect too -- that effect
 * is guarded by the `transitioning` flag so it never fights `cycleTo()`
 * for control of `pageContainer`/`disposePage`. A manual tab tap,
 * idle-reset, or any other direct hash change still goes through the
 * plain, instant path unaffected, both before and after a cycle.
 */
import { currentRoute, type Route } from '../core/router.js';
import { effect } from '../core/signal.js';
import { pageForRoute } from '../pages/registry.js';
import { startAutoCycle } from './autoCycle.js';
import { mountFooterLine } from './FooterLine.js';
import { mountMasthead } from './Masthead.js';

// A fixed pre-warm delay before the visual slide starts, not real
// per-page "data has arrived" readiness: no page module exposes such a
// signal today (each owns its own `resource()` polling internally), and
// adding one to all six just for this would be a much bigger change than
// this feature warrants. 400ms is enough for a `resource()`'s first
// fetch to land on a LAN/broadband connection in the common case without
// the swipe feeling delayed -- a pragmatic, honest middle ground, not a
// guarantee the incoming page is fully populated.
const PREWARM_MS = 400;

// The slide itself. Short enough to read as a deliberate "swipe" on a
// kiosk touchscreen, long enough not to feel like a jump-cut.
const SLIDE_MS = 500;

/**
 * `nextName` comes from `nextCycleRoute`, which only ever returns a
 * `PageId` (never `'settings'`, never `'cameras'` with a `cameraId`), so
 * `{ name: nextName }` alone is always a structurally valid `Route` --
 * this tiny wrapper just names the conversion for readability at the one
 * call site below.
 */
function routeForName(name: Route['name']): Route {
    return { name };
}

export function mountAppShell(root: HTMLElement): () => void {
    root.innerHTML = '';

    const mastheadContainer = document.createElement('header');
    let pageContainer = document.createElement('main');
    pageContainer.className = 'page';
    const footerContainer = document.createElement('footer');

    root.append(mastheadContainer, pageContainer, footerContainer);

    const disposeMasthead = mountMasthead(mastheadContainer);
    const disposeFooter = mountFooterLine(footerContainer);

    let disposePage: (() => void) | undefined;
    let transitioning = false;
    let cancelActiveCycle: (() => void) | undefined;

    /** The swipe-transition path -- see this module's doc comment for the full sequencing. */
    function cycleTo(nextName: Route['name']): void {
        if (transitioning) return; // a transition is already in flight; skip this tick rather than overlap two

        const outgoingContainer = pageContainer;
        const outgoingDispose = disposePage;

        const incomingContainer = document.createElement('main');
        incomingContainer.className = 'page page--incoming';
        // Mounted now, while `outgoingContainer` is still the one on screen
        // and `location.hash` still points at the outgoing route -- this is
        // the "already loaded and fresh" part: the incoming page starts
        // fetching immediately, well before it's ever shown.
        const incomingDispose = pageForRoute(routeForName(nextName)).render(incomingContainer);

        const viewport = document.createElement('div');
        viewport.className = 'page-viewport';
        outgoingContainer.replaceWith(viewport);
        viewport.append(outgoingContainer, incomingContainer);

        transitioning = true;

        const prewarmTimer = setTimeout(() => {
            // Updates `currentRoute` (masthead active-tab highlight, browser
            // state) right as the visual slide begins. The plain route
            // effect below also reacts to this, but `transitioning` guards
            // it from touching `pageContainer`/`disposePage` itself.
            location.hash = `#/${nextName}`;
            outgoingContainer.classList.add('page--slide-out');
            incomingContainer.classList.add('page--slide-in');
        }, PREWARM_MS);

        const finishTimer = setTimeout(() => {
            outgoingDispose?.();
            viewport.replaceWith(incomingContainer);
            incomingContainer.classList.remove('page--incoming', 'page--slide-in');
            pageContainer = incomingContainer;
            disposePage = incomingDispose;
            transitioning = false;
            cancelActiveCycle = undefined;
        }, PREWARM_MS + SLIDE_MS);

        // Lets `dispose()` below tear down a transition that's still in
        // flight when the whole shell is torn down (e.g. navigating away
        // from the app entirely mid-swipe) without leaking either page's
        // effects or leaving orphaned timers.
        cancelActiveCycle = function cancel(): void {
            clearTimeout(prewarmTimer);
            clearTimeout(finishTimer);
            incomingDispose();
            outgoingDispose?.();
            viewport.remove();
            disposePage = undefined;
            transitioning = false;
            cancelActiveCycle = undefined;
        };
    }

    const disposeRouteEffect = effect(() => {
        const route = currentRoute.get();
        if (transitioning) return; // this navigation is being driven by cycleTo() above, not this plain path
        disposePage?.();
        pageContainer.innerHTML = '';
        disposePage = pageForRoute(route).render(pageContainer);
    });

    const disposeAutoCycle = startAutoCycle({ onCycle: cycleTo });

    return function dispose(): void {
        disposeRouteEffect();
        disposeAutoCycle();
        cancelActiveCycle?.();
        disposePage?.();
        disposeMasthead();
        disposeFooter();
        root.innerHTML = '';
    };
}
