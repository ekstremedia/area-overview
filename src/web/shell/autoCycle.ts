/**
 * Auto-cycle: kiosk slideshow mode. `nextCycleRoute` is the pure "what's
 * next" logic (no DOM, no timer -- fully unit-testable on its own).
 * `startAutoCycle` is the timer that calls it repeatedly, on
 * `settings.autoCycle.intervalSeconds`, and hands the result to the
 * caller's `onCycle` -- same split as `idle.ts`'s `startIdleReset`: this
 * module only owns *when*, never *what happens* on a cycle (that's
 * `AppShell.ts`'s swipe-transition path).
 *
 * Deliberately independent of `idle.ts`'s own timer: no attempt to pause
 * auto-cycle around an impending or just-fired idle-reset. The two serve
 * different purposes -- auto-cycle keeps the kiosk moving through
 * content, idle-reset recovers a stranded page after a visitor walks
 * away -- and coupling them would make either timer's behavior depend on
 * the other's internal state. Simplest and most predictable is to let
 * both run independently: an idle-reset firing mid-cycle just looks like
 * an ordinary navigation to auto-cycle's next tick, and vice versa.
 */
import type { PageId, Settings } from '../../shared/schemas/settings.js';
import type { Route } from '../core/router.js';
import { currentRoute } from '../core/router.js';
import { effect, type ReadonlySignal } from '../core/signal.js';
import { settings as sharedSettings } from '../settings-resource.js';

/**
 * Cycling order -- `registry.ts`'s `NAV_PAGES` display order, duplicated
 * here as a plain constant rather than imported from there: this module
 * stays DOM-free and independently unit-testable (`registry.ts` pulls in
 * every page module, Leaflet included), and the two lists are the same
 * five `PageId`s by construction (`registry.test.ts`/`General.ts` are the
 * other two places this order would need to change in lockstep, same as
 * today).
 */
const CYCLE_ORDER: readonly PageId[] = ['map', 'weather', 'aurora', 'tide', 'cameras'];

/**
 * Given the currently-shown route and the live settings, returns the
 * route name to switch to next, or `null` when auto-cycle shouldn't run
 * right now (disabled, or fewer than two eligible pages).
 *
 * "Eligible" is `autoCycle.pages` (or, when that's empty, every page in
 * `enabledPages`) intersected with `enabledPages` again -- so a page
 * listed in `autoCycle.pages` that's since been toggled off is silently
 * skipped rather than cycled to, without needing to be removed from
 * `autoCycle.pages` itself (see `AutoCycleSchema`'s doc comment in
 * `shared/schemas/settings.ts`).
 *
 * `current` not being one of the eligible pages (e.g. the visitor is on
 * `#/settings`, or on a page since disabled) is treated the same as
 * "start from the top": cycling resumes at the first eligible page
 * rather than refusing to fire.
 */
export function nextCycleRoute(current: Route['name'], settings: Settings): Route['name'] | null {
    const { autoCycle, enabledPages } = settings;
    if (!autoCycle.enabled) return null;

    const requested = autoCycle.pages.length > 0 ? autoCycle.pages : enabledPages;
    const eligible = CYCLE_ORDER.filter((id) => requested.includes(id) && enabledPages.includes(id));

    if (eligible.length < 2) return null; // nothing to swipe to, or the only eligible page is the one already showing

    const index = eligible.findIndex((id) => id === current);
    const nextIndex = index === -1 ? 0 : (index + 1) % eligible.length;
    return eligible[nextIndex] ?? null; // unreachable given the length check above; satisfies noUncheckedIndexedAccess
}

export interface StartAutoCycleOptions {
    /** Reactive source of `autoCycle`/`enabledPages`. Defaults to the shared settings resource; tests inject their own. */
    settings?: ReadonlySignal<Settings>;
    /** Reactive source of the currently-shown route. Defaults to the shared router; tests inject their own. */
    route?: ReadonlySignal<Route>;
    /** Called with the next route's name each time the timer fires and `nextCycleRoute` finds one. The caller decides what a "cycle" actually does (`AppShell.ts`'s swipe transition). */
    onCycle: (nextRouteName: Route['name']) => void;
}

/** A cheap structural key for the fields that govern re-arming -- see the `lastArmedKey` doc below. The route is part of it because the interval is measured from the page currently showing: see `startAutoCycle`. */
function armKey(settings: Settings, route: Route): string {
    const page = route.name === 'cameras' && route.cameraId !== undefined ? `cameras/${route.cameraId}` : route.name;
    return `${String(settings.autoCycle.enabled)}:${String(settings.autoCycle.intervalSeconds)}:${settings.autoCycle.pages.join(',')}:${page}`;
}

export function startAutoCycle(options: StartAutoCycleOptions): () => void {
    const settingsSignal = options.settings ?? sharedSettings;
    const routeSignal = options.route ?? currentRoute;
    const onCycle = options.onCycle;

    let timer: ReturnType<typeof setInterval> | undefined;
    // Tracks the last-armed (enabled, intervalSeconds, pages, route)
    // combination so a settings *poll* that leaves them unchanged doesn't
    // restart the in-flight interval -- same reasoning, and same shape, as
    // `idle.ts`'s `lastArmedSeconds`. `enabledPages` changing alone does
    // NOT re-arm: it only affects *which* page `nextCycleRoute` picks next,
    // not the timing, so it's read fresh on every `fire()` instead.
    //
    // The route IS part of the key: the interval is "this page has been up
    // for N seconds", not a metronome running since the app booted. Without
    // it, tapping a tab a second before the timer happened to be due would
    // swipe the page away immediately -- the visitor's own navigation
    // undone by a tick they never saw coming. Re-arming also means an
    // auto-cycle's own hash change restarts the clock, so every page gets
    // its full interval however long the slide before it took.
    let lastArmedKey: string | undefined;

    function clear(): void {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    }

    function fire(): void {
        const next = nextCycleRoute(routeSignal.get().name, settingsSignal.get());
        if (next !== null) onCycle(next);
    }

    function arm(settings: Settings): void {
        clear();
        if (!settings.autoCycle.enabled) return; // disabled: no timer at all.
        timer = setInterval(fire, settings.autoCycle.intervalSeconds * 1000);
    }

    const disposeEffect = effect(() => {
        const settings = settingsSignal.get();
        const key = armKey(settings, routeSignal.get());
        if (key !== lastArmedKey) {
            lastArmedKey = key;
            arm(settings);
        }
    });

    return function dispose(): void {
        disposeEffect();
        clear();
    };
}
