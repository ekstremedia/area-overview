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
 * The slide (`slideTo()` below) is how EVERY navigation looks, not just
 * an auto-cycle: it mounts the incoming page into its own container
 * while the outgoing page is still fully on screen, then runs a CSS
 * slide transition between the two before disposing the outgoing page
 * and settling back to the normal single-container steady state. The two
 * callers differ only in what they own:
 *
 * - Auto-cycle (`autoCycle.ts`'s timer) drives the route itself, so it
 *   pre-warms the incoming page for `PREWARM_MS` (a head start on
 *   fetching, while nothing has visibly happened yet) and publishes
 *   `location.hash` as the slide begins.
 * - A manual navigation -- a masthead tap, an idle-reset, any direct
 *   hash change -- has already changed the hash, and the visitor has
 *   just touched the screen, so the slide starts at once with no
 *   pre-warm: a delay there would read as the tap not registering.
 *
 * Because the auto-cycle path updates `location.hash` mid-slide, that
 * fires the plain route effect too -- while a slide is in flight, the
 * effect compares the new route against the slide's own target
 * (`slideTargetRoute`): the same route means this is just the slide's
 * own hash update reaching the effect, a no-op; a DIFFERENT route means
 * a real navigation landed mid-slide, and the effect aborts the
 * in-flight slide and mounts the actually-requested page instantly, so
 * that navigation is never silently lost (and a visitor jabbing at tabs
 * gets the page they asked for rather than a queue of animations).
 */
import { currentRoute, navigateToRoute, type Route } from '../core/router.js';
import { effect } from '../core/signal.js';
import { pageForRoute } from '../pages/registry.js';
import { startAutoCycle } from './autoCycle.js';
import { mountFooterLine } from './FooterLine.js';
import { mountMasthead } from './Masthead.js';

// A fixed pre-warm delay before an auto-cycle's visual slide starts, not
// real per-page "data has arrived" readiness: no page module exposes
// such a signal today (each owns its own `resource()` polling
// internally), and adding one to all six just for this would be a much
// bigger change than this feature warrants. 400ms is enough for a
// `resource()`'s first fetch to land on a LAN/broadband connection in
// the common case without the swipe feeling delayed -- a pragmatic,
// honest middle ground, not a guarantee the incoming page is fully
// populated.
const PREWARM_MS = 400;

// A manual navigation gets none: the visitor has just tapped, and any
// delay before the page moves reads as the tap being ignored. The
// incoming page is still mounted before the slide starts, it just gets
// no head start.
const MANUAL_PREWARM_MS = 0;

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

/** `Route` equality, including `cameras`' optional `cameraId` -- comparing only `.name` would treat `#/cameras/<id>` and plain `#/cameras` as the same route, which matters for telling "the hash change cycleTo() itself just made" from "a real navigation that interrupted an in-flight cycle" below. */
function routesEqual(a: Route, b: Route): boolean {
    if (a.name !== b.name) return false;
    if (a.name === 'cameras' && b.name === 'cameras') return a.cameraId === b.cameraId;
    return true;
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
    /** The route currently mounted in `pageContainer` (or being slid to). `undefined` until the first mount. */
    let mountedRoute: Route | undefined;
    let transitioning = false;
    let cancelActiveTransition: (() => void) | undefined;
    // The route an auto-cycle's own `location.hash` update (in its prewarm
    // timer, below) is about to produce -- lets the plain route effect
    // tell "the hash change I myself just caused" from "a real navigation
    // that happened to land during my transition window" (see the effect
    // below).
    let slideTargetRoute: Route | undefined;

    /** Creates a fresh, empty, attached `<main class="page">` in `pageContainer`'s usual spot -- used after aborting an in-flight slide, whose outgoing/incoming containers both get torn down, to leave a valid attachment point for whatever navigation interrupted it. */
    function freshPageContainer(): HTMLElement {
        const container = document.createElement('main');
        container.className = 'page';
        footerContainer.before(container);
        return container;
    }

    /** The plain, instant path: replace whatever is in the single steady-state container. Used for the very first mount and for a navigation that interrupted a slide. */
    function mountNow(route: Route): void {
        disposePage?.();
        pageContainer.innerHTML = '';
        disposePage = pageForRoute(route).render(pageContainer);
        mountedRoute = route;
    }

    /**
     * The slide -- see this module's doc comment for the full sequencing.
     * `publishHash` is what separates the two callers: an auto-cycle owns
     * the route and publishes it as the slide starts, a manual navigation
     * is already at the target route by the time it gets here.
     */
    function slideTo(targetRoute: Route, prewarmMs: number, publishHash: boolean): void {
        if (transitioning) return; // a slide is already in flight; skip rather than overlap two

        const outgoingContainer = pageContainer;
        const outgoingDispose = disposePage;
        slideTargetRoute = targetRoute;
        mountedRoute = targetRoute;

        const incomingContainer = document.createElement('main');
        incomingContainer.className = 'page page--incoming';

        const viewport = document.createElement('div');
        viewport.className = 'page-viewport';
        outgoingContainer.replaceWith(viewport);
        viewport.append(outgoingContainer, incomingContainer);

        // Rendered only once the container is attached and has its real
        // box. A page that measures anything at render time (Leaflet's map
        // above all) sees 0x0 in a detached `<main>` and lays itself out
        // for it, then re-measures once something happens to poke it --
        // which is exactly the "cramped during the slide, then it
        // uncramps" flicker. Everything after this line still happens
        // while `outgoingContainer` is the one on screen, so this is
        // unchanged as far as the visitor is concerned.
        const incomingDispose = pageForRoute(targetRoute).render(incomingContainer);

        transitioning = true;

        const prewarmTimer = setTimeout(() => {
            if (publishHash) {
                // Updates `currentRoute` (masthead active-tab highlight,
                // browser state) right as the visual slide begins. The plain
                // route effect below also reacts to this, but `transitioning`
                // guards it from touching `pageContainer`/`disposePage`.
                navigateToRoute(targetRoute);
            }
            // Forces the browser to compute `page--incoming`'s off-screen
            // transform before the slide classes change it. Without a style
            // flush in between, a zero-delay slide (the manual path) can set
            // both in one go and the browser has nothing to animate *from*,
            // so the page jumps instead of sliding.
            incomingContainer.getBoundingClientRect();
            outgoingContainer.classList.add('page--slide-out');
            incomingContainer.classList.add('page--slide-in');
        }, prewarmMs);

        const finishTimer = setTimeout(() => {
            outgoingDispose?.();
            viewport.replaceWith(incomingContainer);
            incomingContainer.classList.remove('page--incoming', 'page--slide-in');
            pageContainer = incomingContainer;
            disposePage = incomingDispose;
            transitioning = false;
            cancelActiveTransition = undefined;
            slideTargetRoute = undefined;
        }, prewarmMs + SLIDE_MS);

        // Tears down a slide that's still in flight, discarding BOTH
        // containers -- used when the whole shell is torn down mid-swipe
        // (e.g. navigating away from the app entirely), and also when a
        // real navigation (a tab tap, idle-reset, a direct hash change)
        // interrupts one: that case needs a fresh, attached container left
        // behind so the route effect below has somewhere valid to mount
        // the actually-requested page into.
        cancelActiveTransition = function cancel(): void {
            clearTimeout(prewarmTimer);
            clearTimeout(finishTimer);
            incomingDispose();
            outgoingDispose?.();
            viewport.remove();
            pageContainer = freshPageContainer();
            disposePage = undefined;
            mountedRoute = undefined;
            transitioning = false;
            cancelActiveTransition = undefined;
            slideTargetRoute = undefined;
        };
    }

    const disposeRouteEffect = effect(() => {
        const route = currentRoute.get();
        if (transitioning) {
            // A hash change landed while a slide is in flight. If it matches
            // the slide's own target, this is just the auto-cycle path's own
            // `location.hash` update reaching this effect -- already being
            // handled, so do nothing. Otherwise a real navigation (tab tap,
            // idle-reset, direct hash change) interrupted the slide: abort
            // it and mount the actually-requested route instantly, rather
            // than silently losing it (the slide would otherwise commit to
            // its own target regardless, a few hundred ms later) or queueing
            // a second animation behind the first.
            if (slideTargetRoute && routesEqual(route, slideTargetRoute)) return;
            cancelActiveTransition?.();
            mountNow(route);
            return;
        }
        // The first mount has nothing to slide away from, and a hash change
        // that lands on the route already showing (the idle reset's
        // `#/`, a tap on the active tab) would slide the page to a fresh
        // copy of itself -- both re-render in place instead.
        if (mountedRoute === undefined || routesEqual(route, mountedRoute)) {
            mountNow(route);
            return;
        }
        slideTo(route, MANUAL_PREWARM_MS, false);
    });

    const disposeAutoCycle = startAutoCycle({
        onCycle: (nextName) => {
            slideTo(routeForName(nextName), PREWARM_MS, true);
        },
    });

    return function dispose(): void {
        disposeRouteEffect();
        disposeAutoCycle();
        cancelActiveTransition?.();
        disposePage?.();
        disposeMasthead();
        disposeFooter();
        root.innerHTML = '';
    };
}
