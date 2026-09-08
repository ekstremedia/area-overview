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
import { effect, signal, type ReadonlySignal, type Signal } from '../core/signal.js';
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

/**
 * Whether the visitor has paused the slideshow, from the masthead's
 * play/pause control.
 *
 * Deliberately session-only, not a setting: `autoCycle.enabled` is a
 * configuration decision that needs a login to change and belongs to the
 * kiosk, while this is "hold on, I am reading this" -- and a wall display
 * nobody has touched in an hour should be cycling again, not still frozen
 * on whatever page someone paused before lunch. A reload resumes.
 */
export const autoCyclePaused: Signal<boolean> = signal(false);

/**
 * The interval currently counting down: when it started, and how long it
 * runs. What the masthead's progress bar draws.
 *
 * `null` when nothing is armed at all (auto-cycle switched off, or fewer
 * than two eligible pages). A *pause* deliberately leaves the last value
 * standing rather than clearing it, so the bar freezes where it got to
 * instead of emptying; resuming arms a fresh interval and the bar
 * restarts from nothing, which is what actually happens.
 */
export const autoCycleArmed: Signal<{ armedAt: number; intervalSeconds: number } | null> = signal(null);

export interface StartAutoCycleOptions {
    /** Reactive source of `autoCycle`/`enabledPages`. Defaults to the shared settings resource; tests inject their own. */
    settings?: ReadonlySignal<Settings>;
    /** Reactive source of the currently-shown route. Defaults to the shared router; tests inject their own. */
    route?: ReadonlySignal<Route>;
    /** Called with the next route's name each time the timer fires and `nextCycleRoute` finds one. The caller decides what a "cycle" actually does (`AppShell.ts`'s swipe transition). */
    onCycle: (nextRouteName: Route['name']) => void;
}

/** A cheap structural key for the fields that govern re-arming -- see the `lastArmedKey` doc below. The route is part of it because the interval is measured from the page currently showing: see `startAutoCycle`. */
function armKey(settings: Settings, route: Route, paused: boolean, canCycle: boolean): string {
    const page = route.name === 'cameras' && route.cameraId !== undefined ? `cameras/${route.cameraId}` : route.name;
    return [
        String(settings.autoCycle.enabled),
        String(settings.autoCycle.intervalSeconds),
        settings.autoCycle.pages.join(','),
        page,
        String(paused),
        String(canCycle),
    ].join(':');
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

    function arm(settings: Settings, canCycle: boolean): void {
        clear();
        // Switched off, or nowhere to go (one eligible page, or none):
        // there is no countdown to draw, and a bar filling towards a page
        // change that cannot happen is a lie the masthead would tell every
        // interval, forever.
        if (!settings.autoCycle.enabled || !canCycle) {
            autoCycleArmed.set(null);
            return;
        }
        // Paused keeps the last armed interval standing on purpose -- see
        // `autoCycleArmed` -- so the masthead's bar freezes rather than
        // emptying.
        if (autoCyclePaused.get()) return;
        timer = setInterval(fire, settings.autoCycle.intervalSeconds * 1000);
        autoCycleArmed.set({ armedAt: Date.now(), intervalSeconds: settings.autoCycle.intervalSeconds });
    }

    const disposeEffect = effect(() => {
        const settings = settingsSignal.get();
        const route = routeSignal.get();
        // `enabledPages` still doesn't re-arm on its own -- but whether a
        // cycle is possible at all does, since that is the difference
        // between a timer and no timer.
        const canCycle = nextCycleRoute(route.name, settings) !== null;
        const key = armKey(settings, route, autoCyclePaused.get(), canCycle);
        if (key !== lastArmedKey) {
            lastArmedKey = key;
            arm(settings, canCycle);
        }
    });

    return function dispose(): void {
        disposeEffect();
        clear();
        autoCycleArmed.set(null);
    };
}
