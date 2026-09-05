/**
 * Proves `AppShell.ts` actually disposes the previous page's effects on
 * every navigation -- the single most safety-critical behavior in that
 * module (see its doc comment). The technique: capture a reference to a
 * page's own title element *before* navigating away from it, then change
 * `settings.language` (which every placeholder page's title tracks via a
 * live `effect()`). A properly disposed page's captured element is
 * detached and frozen -- its `effect()` no longer runs, so its
 * `textContent` never changes again. A leaked page's captured element
 * would still be subscribed and would pick up the new language even
 * though it's no longer on screen. This mirrors the leak-detection
 * technique Phase 4's own tests use for `effect()` itself (a control
 * observation that must stay exactly as responsive as expected, no more,
 * no less), one level up the stack.
 */
import { describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

// This test's whole job is proving `AppShell.ts` disposes the PREVIOUS
// page on every navigation, generically, across every route -- not
// exercising any one page's own internals (each real page has its own
// unit tests: `pages/map/` for the map, each of `WeatherPage.test.ts`/
// `AuroraPage.test.ts`/`TidePage.test.ts`/`CamerasPage.test.ts` for the
// Phase 8 content pages, and `pages/settings/*.test.ts` for Phase 9's
// settings sections). Every page module here mounts real network
// polling (`resource()`) or, for the map, real Leaflet via a dynamic
// `import('leaflet')` -- exactly the kind of real-network/real-DOM
// dependency this generic shell test should stay decoupled from --
// mocked back to the same synchronous placeholder shape, so the technique
// below (capture a title element, change language, assert only the live
// page's title moved) keeps working unchanged for every route. Each mock
// factory imports `createPlaceholderPage` itself, dynamically, rather
// than this file doing so at the top: a static top-level import here
// would eagerly pull in `i18n/index.js` -> `settings-resource.js` (the
// mocked module) *before* `mockSettings` above finishes initializing,
// hitting a temporal-dead-zone `ReferenceError` (mocks are hoisted above
// regular top-level statements, imports included). `CameraViewerPage.js`
// needs no mock here: `ROUTE_HASHES` below never navigates to
// `#/cameras/<id>`, only plain `#/cameras`.
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
// Phase 9's real SettingsPage mounts its own resource() poll (via
// createSettingsStore()), the on-screen keyboard, and several sections --
// exactly the kind of real-network/real-DOM dependency this generic shell
// test stays decoupled from, same reasoning as every other route above.
vi.mock('../pages/SettingsPage.js', async () => {
    const { createPlaceholderPage } = await import('../pages/placeholder.js');
    return { render: createPlaceholderPage('nav.settings', 'locality.settings') };
});

const { mountAppShell } = await import('./AppShell.js');

function navigate(hash: string): void {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function setLanguage(language: 'nb' | 'en'): void {
    mockSettings.set({ ...mockSettings.get(), language });
}

const ROUTE_HASHES = ['#/map', '#/weather', '#/aurora', '#/tide', '#/cameras', '#/settings'];

describe('AppShell navigation disposal', () => {
    it('disposes every earlier page on navigation: only the live page reacts to a later settings change', () => {
        setLanguage('nb');
        const root = document.createElement('div');
        document.body.appendChild(root);
        const disposeShell = mountAppShell(root);

        const captured: { el: HTMLElement; textAtCapture: string }[] = [];
        for (const hash of ROUTE_HASHES) {
            navigate(hash);
            const title = root.querySelector<HTMLElement>('.page-placeholder-title');
            if (!title) throw new Error(`no title rendered for ${hash}`);
            captured.push({ el: title, textAtCapture: title.textContent });
        }

        // One settings change: only whichever page is currently mounted
        // (the last one navigated to, #/settings) may react to it.
        setLanguage('en');

        const liveTitle = root.querySelector<HTMLElement>('.page-placeholder-title');
        expect(liveTitle?.textContent).toBe('Settings');

        const earlierPages = captured.slice(0, -1); // every route except the current (#/settings) one
        expect(earlierPages).toHaveLength(5);
        for (const { el, textAtCapture } of earlierPages) {
            expect(el.isConnected).toBe(false); // removed from the DOM by AppShell
            expect(el.textContent).toBe(textAtCapture); // and its effect never ran again
        }

        disposeShell();
    });

    it('repeated navigation cycles leave no accumulating leak', () => {
        setLanguage('nb');
        const root = document.createElement('div');
        const disposeShell = mountAppShell(root);

        for (let cycle = 0; cycle < 4; cycle++) {
            for (const hash of ROUTE_HASHES) navigate(hash);
        }

        // After 24 navigations (4 full cycles), flipping the language back
        // and forth must still only ever move the one currently-live title.
        for (let i = 0; i < 4; i++) {
            const language = i % 2 === 0 ? 'en' : 'nb';
            setLanguage(language);
            const title = root.querySelector<HTMLElement>('.page-placeholder-title');
            expect(title?.textContent).toBe(language === 'en' ? 'Settings' : 'Innstillinger');
        }

        disposeShell();
    });

    it("dispose()'ing the shell itself tears down the currently-mounted page too", () => {
        setLanguage('nb');
        const root = document.createElement('div');
        const disposeShell = mountAppShell(root);

        navigate('#/weather');
        const title = root.querySelector<HTMLElement>('.page-placeholder-title');
        if (!title) throw new Error('no title rendered');
        const textAtCapture = title.textContent;

        disposeShell();
        setLanguage('en');

        expect(title.textContent).toBe(textAtCapture);
        expect(root.innerHTML).toBe('');
    });
});
