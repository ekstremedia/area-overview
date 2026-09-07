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

beforeEach(() => {
    vi.useFakeTimers();
    location.hash = '#/map';
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

    it('a manual navigation right after a completed cycle still uses the plain instant path, with no leftover viewport', () => {
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        vi.advanceTimersByTime(30_000 + 400 + 500); // one full cycle: map -> weather

        location.hash = '#/aurora';
        window.dispatchEvent(new HashChangeEvent('hashchange'));

        const title = root.querySelector<HTMLElement>('.page-placeholder-title');
        expect(title?.textContent).toBe('Nordlys');
        expect(root.querySelectorAll('.page-placeholder-title')).toHaveLength(1);
        expect(root.querySelector('.page-viewport')).toBeNull();

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
        expect(liveTitle?.textContent).toBe('Tide'); // map -> weather -> aurora -> tide after 4 full cycles (captured, then cycled, on each iteration)

        for (const title of capturedTitles) {
            expect(title.isConnected).toBe(false);
        }

        disposeShell();
    });
});
