/**
 * Proves `AppShell.ts`'s auto-cycle swipe-transition path (`cycleTo()`):
 * the incoming page is mounted and pre-warming while the outgoing page
 * is still on screen, the hash/DOM settle back to the normal single-
 * container steady state once the transition finishes, and -- the part
 * that matters most, mirroring `router-integration.test.ts`'s technique
 * for the plain path -- the outgoing page is genuinely disposed, not
 * just visually hidden or removed: its captured title element stops
 * reacting to a later settings change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] } }));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

// Same reasoning as `router-integration.test.ts` for mocking every page
// module back to a synchronous placeholder: this test's job is proving
// AppShell's transition/disposal mechanics generically, not any one
// page's real content.
vi.mock('../pages/MapPage.js', async () => {
    const { createPlaceholderPage } = await import('../pages/placeholder.js');
    return { render: createPlaceholderPage('nav.map', 'locality.map') };
});
vi.mock('../pages/WeatherPage.js', async () => {
    const { createPlaceholderPage } = await import('../pages/placeholder.js');
    return { render: createPlaceholderPage('nav.weather', 'locality.weather') };
});
vi.mock('../pages/AuroraPage.js', async () => {
    const { createPlaceholderPage } = await import('../pages/placeholder.js');
    return { render: createPlaceholderPage('nav.aurora', 'locality.aurora') };
});
vi.mock('../pages/TidePage.js', async () => {
    const { createPlaceholderPage } = await import('../pages/placeholder.js');
    return { render: createPlaceholderPage('nav.tide', 'locality.tide') };
});
vi.mock('../pages/CamerasPage.js', async () => {
    const { createPlaceholderPage } = await import('../pages/placeholder.js');
    return { render: createPlaceholderPage('nav.cameras', 'locality.cameras') };
});
vi.mock('../pages/SettingsPage.js', async () => {
    const { createPlaceholderPage } = await import('../pages/placeholder.js');
    return { render: createPlaceholderPage('nav.settings', 'locality.settings') };
});

const { mountAppShell } = await import('./AppShell.js');

function setLanguage(language: 'nb' | 'en'): void {
    mockSettings.set({ ...mockSettings.get(), language });
}

/** A hash change, as the masthead's tabs and the idle reset produce one. Timers are left alone: what happens *next* is what most of these tests are about. */
function navigate(hash: string): void {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
}

beforeEach(() => {
    vi.useFakeTimers();
    // Dispatched, not just assigned: `currentRoute` is a module-level
    // signal shared by every test in this file, and happy-dom fires no
    // `hashchange` of its own on an assignment -- without this, each test
    // would start on whatever route the one before it left behind.
    navigate('#/map');
    mockSettings.set(SettingsSchema.parse({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] } }));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('AppShell auto-cycle swipe transition', () => {
    it('pre-warms the incoming page while the outgoing page is still shown, then swaps and disposes the outgoing page', () => {
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        const outgoingTitle = root.querySelector<HTMLElement>('.page-placeholder-title');
        if (!outgoingTitle) throw new Error('no title rendered for the initial page');
        const outgoingTextAtCapture = outgoingTitle.textContent;

        // Auto-cycle's timer fires (intervalSeconds: 30) -- the incoming
        // page mounts immediately, into its own hidden container, while
        // the outgoing page is still the one actually on screen and the
        // hash/route haven't changed yet.
        vi.advanceTimersByTime(30_000);

        const titlesDuringPrewarm = [...root.querySelectorAll<HTMLElement>('.page-placeholder-title')];
        expect(titlesDuringPrewarm).toHaveLength(2);
        expect(location.hash).toBe('#/map');
        expect(outgoingTitle.isConnected).toBe(true); // still on screen, not disposed yet

        // Pre-warm delay elapses: the hash updates and the visual slide begins.
        vi.advanceTimersByTime(400);
        expect(location.hash).toBe('#/weather');

        // The slide itself elapses: the outgoing page is disposed and the
        // DOM settles back to a single, plain `.page` container.
        vi.advanceTimersByTime(500);

        const settledTitles = [...root.querySelectorAll<HTMLElement>('.page-placeholder-title')];
        expect(settledTitles).toHaveLength(1);
        expect(settledTitles[0]?.textContent).toBe('Vær'); // nb
        expect(root.querySelector('.page-viewport')).toBeNull();
        expect(outgoingTitle.isConnected).toBe(false);

        // The disposal proof itself: a settings change now only reaches the
        // live (incoming, now current) page -- the outgoing page's captured
        // title element never reacts again.
        setLanguage('en');
        expect(outgoingTitle.textContent).toBe(outgoingTextAtCapture);
        expect(settledTitles[0]?.textContent).toBe('Weather');

        disposeShell();
    });

    it('disposing the shell mid-transition tears down both the outgoing and the pre-warmed incoming page', () => {
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        const outgoingTitle = root.querySelector<HTMLElement>('.page-placeholder-title');
        if (!outgoingTitle) throw new Error('no title rendered for the initial page');
        const outgoingTextAtCapture = outgoingTitle.textContent;

        vi.advanceTimersByTime(30_000); // cycle fires, incoming page pre-warms
        const incomingTitle = [...root.querySelectorAll<HTMLElement>('.page-placeholder-title')].at(-1);
        if (!incomingTitle) throw new Error('no title rendered for the incoming page');
        const incomingTextAtCapture = incomingTitle.textContent;

        disposeShell(); // torn down before the pre-warm delay has even elapsed
        expect(root.innerHTML).toBe('');

        setLanguage('en');
        expect(outgoingTitle.textContent).toBe(outgoingTextAtCapture);
        expect(incomingTitle.textContent).toBe(incomingTextAtCapture);
    });

    it('slides on a manual navigation too, with no pre-warm delay before the page starts moving', () => {
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        const outgoingTitle = root.querySelector<HTMLElement>('.page-placeholder-title');
        if (!outgoingTitle) throw new Error('no title rendered for the initial page');

        navigate('#/aurora');

        // Both pages are on screen, in the sliding wrapper, and the slide is
        // already under way: a tap gets no pre-warm, since a delay before
        // anything moves reads as the tap not registering.
        const viewport = root.querySelector('.page-viewport');
        expect(viewport).not.toBeNull();
        expect(root.querySelectorAll('.page-placeholder-title')).toHaveLength(2);
        vi.advanceTimersByTime(0); // the zero-delay prewarm timer, i.e. the very next task
        expect(root.querySelector('.page--slide-out')).not.toBeNull();
        expect(root.querySelector('.page--slide-in')).not.toBeNull();

        vi.advanceTimersByTime(500);

        const title = root.querySelector<HTMLElement>('.page-placeholder-title');
        expect(title?.textContent).toBe('Nordlys');
        expect(root.querySelectorAll('.page-placeholder-title')).toHaveLength(1);
        expect(root.querySelector('.page-viewport')).toBeNull();
        expect(outgoingTitle.isConnected).toBe(false); // disposed, exactly as on an auto-cycle

        disposeShell();
    });

    it('re-renders in place, without a slide, when the hash lands on the page already showing', () => {
        // The idle reset's `#/` and a tap on the already-active tab both do
        // this. Sliding a page to a fresh copy of itself is a jarring
        // animation that says something changed when nothing did.
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        navigate('#/map');

        expect(root.querySelector('.page-viewport')).toBeNull();
        expect(root.querySelectorAll('.page-placeholder-title')).toHaveLength(1);

        disposeShell();
    });

    it('a second navigation mid-slide lands instantly on the page asked for, rather than queueing another animation', () => {
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        navigate('#/aurora');
        navigate('#/tide'); // jabbed at a third tab before the first slide finished

        const titles = [...root.querySelectorAll<HTMLElement>('.page-placeholder-title')];
        expect(titles).toHaveLength(1);
        expect(titles[0]?.textContent).toBe('Tidevann');
        expect(root.querySelector('.page-viewport')).toBeNull();

        disposeShell();
    });

    it('gives a manually-chosen page the full auto-cycle interval before swiping it away', () => {
        // Without this, tapping a tab a second before the timer happened to
        // be due would swipe the page away almost immediately -- the
        // visitor's own navigation undone by a tick they never saw coming.
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        vi.advanceTimersByTime(29_000); // one second short of a cycle
        navigate('#/tide');
        vi.advanceTimersByTime(29_000); // that missing second, and then some

        expect(root.querySelector<HTMLElement>('.page-placeholder-title')?.textContent).toBe('Tidevann');
        expect(location.hash).toBe('#/tide');

        // The interval is measured from the navigation, so the cycle away
        // from it lands a full 30s after the tap, not before.
        vi.advanceTimersByTime(1_000 + 400 + 500);
        expect(location.hash).toBe('#/cameras');

        disposeShell();
    });

    it('repeated cycles leave no accumulating leak: only the currently-live title ever reacts again', () => {
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        const capturedTitles: HTMLElement[] = [];
        for (let i = 0; i < 4; i++) {
            const current = root.querySelector<HTMLElement>('.page-placeholder-title');
            if (current) capturedTitles.push(current);
            vi.advanceTimersByTime(30_000 + 400 + 500); // one full cycle
        }

        setLanguage('en');
        const liveTitle = root.querySelector<HTMLElement>('.page-placeholder-title');
        expect(liveTitle?.textContent).toBe('Cameras'); // map -> weather -> aurora -> tide -> cameras, one cycle per iteration

        for (const title of capturedTitles) {
            expect(title.isConnected).toBe(false);
        }

        disposeShell();
    });
});
