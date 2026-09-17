import { describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { mountMasthead } = await import('./Masthead.js');
const { emptyLayerCounts, liveLayerCounts, liveLayerListing, pageAccountStatus, pageFreshness } = await import('./page-status.js');
type LiveLayerItem = import('./page-status.js').LiveLayerItem;
type LiveLayerGroupId = import('./page-status.js').LiveLayerGroupId;
const { autoCycleArmed, autoCyclePaused } = await import('./autoCycle.js');

function navigate(hash: string): void {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function setSettings(patch: Partial<Settings>): void {
    mockSettings.set({ ...mockSettings.get(), ...patch });
}

/** Every group at zero but the ones this test cares about -- the masthead counts four groups now, not two. */
function counts(partial: Partial<ReturnType<typeof emptyLayerCounts>>): ReturnType<typeof emptyLayerCounts> {
    return { ...emptyLayerCounts(), ...partial };
}

/** The listing with only the named groups populated; the rest arrive empty, as the map page really publishes them. */
function listing(groups: Partial<Record<LiveLayerGroupId, LiveLayerItem[]>>, focus: (item: LiveLayerItem) => void) {
    return {
        items: { ships: [], aircraft: [], roadSituations: [], roadCameras: [], transit: [], warnings: [], species: [], ...groups },
        focus,
    };
}

describe('mountMasthead', () => {
    it('renders the nav tabs and the settings gear in one row, marking the active tab -- with no cameras tab, even when settings still list it', () => {
        // `'cameras'` is deliberately still a legal `enabledPages` entry
        // (an existing `data/settings.json` carries it), but the tab row
        // is built from `NAV_PAGES`, which the dormancy flag has already
        // filtered -- so the stale entry produces no tab.
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        navigate('#/weather');
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const tabs = [...container.querySelectorAll<HTMLAnchorElement>('.masthead-tab')];
        expect(tabs.map((tab) => tab.textContent)).toEqual(['Kart', 'Vær', 'Nordlys', 'Tidevann']);

        const activeTab = container.querySelector('.masthead-tab--active');
        expect(activeTab?.textContent).toBe('Vær');
        expect(activeTab?.getAttribute('href')).toBe('#/weather');

        // The wordmark and locality line are gone from the design: one row
        // now, so a name that never changes doesn't spend vertical space.
        expect(container.querySelector('.masthead-brand')).toBeNull();
        expect(container.querySelector('.masthead-locality')).toBeNull();

        // The Settings link is an icon, so its accessible name has to come
        // from `aria-label` -- there is no text left to read.
        const settingsLink = container.querySelector<HTMLAnchorElement>('.masthead-settings-link');
        expect(settingsLink?.getAttribute('href')).toBe('#/settings');
        expect(settingsLink?.getAttribute('aria-label')).toBe('Innstillinger');
        expect(settingsLink?.querySelector('svg')).not.toBeNull();

        dispose();
    });

    it('hides a tab not present in settings.enabledPages', () => {
        setSettings({ enabledPages: ['map', 'weather'] });
        navigate('#/map');
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const visibleTabs = [...container.querySelectorAll<HTMLAnchorElement>('.masthead-tab')].filter((tab) => tab.style.display !== 'none');
        expect(visibleTabs.map((tab) => tab.textContent)).toEqual(['Kart', 'Vær']);

        dispose();
    });

    it('shows live layer counts only on the map route, and only once set', () => {
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        liveLayerCounts.set(null);
        navigate('#/map');
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const layerCounts = container.querySelector<HTMLElement>('.masthead-layer-counts');
        expect(layerCounts?.style.display).toBe('none');

        liveLayerCounts.set(counts({ ships: 14, aircraft: 3 }));
        expect(layerCounts?.style.display).not.toBe('none');
        expect(layerCounts?.textContent).toContain('14 skip');
        expect(layerCounts?.textContent).toContain('3 fly');

        // The numeral carries its layer's colour while the unit stays
        // muted, which is why the counts are separate elements rather than
        // one formatted string.
        expect(container.querySelector('.masthead-count-ships')?.textContent).toBe('14');
        expect(container.querySelector('.masthead-count-aircraft')?.textContent).toBe('3');

        // Nothing held back, nothing said: the ordinary line must not carry
        // a permanent "0 skjult" tail. The toggled element is the wrapper
        // around the numeral, not the numeral itself.
        const hidden = container.querySelector<HTMLElement>('.masthead-count-hidden');
        // `textContent` still includes a display:none node's text, so the
        // visibility of the wrapper is the thing worth asserting -- that is
        // what actually keeps "0 skjult" off the screen.
        expect(hidden?.parentElement?.style.display).toBe('none');

        // With vessels held back by the age filter, the line accounts for
        // them rather than letting them vanish unexplained.
        liveLayerCounts.set(counts({ ships: 11, hiddenByAge: 1 }));
        expect(hidden?.parentElement?.style.display).not.toBe('none');
        expect(layerCounts?.textContent).toContain('1 skjult');

        // This count opens nothing, so it is a `<span>` rather than a
        // `<button>` -- and an `aria-label` on a generic element with no
        // role is ignored outright. `role="img"` is what makes the name
        // reach a screen reader, which matters below 1300px where the
        // unit word is `display: none` and "1" is all that is left.
        const hiddenPart = hidden?.parentElement;
        expect(hiddenPart?.tagName).toBe('SPAN');
        expect(hiddenPart?.getAttribute('role')).toBe('img');
        expect(hiddenPart?.getAttribute('aria-label')).toBe('1 skjult');

        navigate('#/weather');
        expect(layerCounts?.style.display).toBe('none');

        liveLayerCounts.set(null);
        dispose();
    });

    it('aligns the first clock tick to the next wall-clock minute boundary, not 60s after mount', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T12:00:47.000Z'));
            const container = document.createElement('div');
            const dispose = mountMasthead(container);

            const clock = container.querySelector<HTMLElement>('.masthead-datetime');
            const initialText = clock?.textContent;
            // The date and the clock share one element now.
            expect(initialText).toContain('·');

            // Mounted at :47 -- the boundary is 13s away. Advancing by less than
            // that must not tick the clock forward yet.
            vi.advanceTimersByTime(12_000);
            expect(clock?.textContent).toBe(initialText);

            // Crossing the boundary (13s after mount) ticks to the new minute.
            vi.advanceTimersByTime(1_000);
            expect(clock?.textContent).not.toBe(initialText);

            dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows the stale banner only once the active page is actually stale', () => {
        pageFreshness.set(null);
        navigate('#/map');
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const staleBanner = container.querySelector<HTMLElement>('.masthead-stale-banner');
        expect(staleBanner?.style.display).toBe('none');

        pageFreshness.set({ fetchedAt: new Date(Date.now() - 10_000), intervalMs: 1_000 }); // 10s old, 3x interval is 3s -- stale
        expect(staleBanner?.style.display).not.toBe('none');
        expect(staleBanner?.textContent).toContain('Gamle data');

        pageFreshness.set(null);
        dispose();
    });

    it('shows the weekday, date and time together', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-08-31T12:42:00.000Z'));
            const container = document.createElement('div');
            const dispose = mountMasthead(container);

            // Norwegian long form, replacing the locality line that used to
            // sit here: "mandag 31. august · 12:42".
            const dateTime = container.querySelector<HTMLElement>('.masthead-datetime')?.textContent ?? '';
            expect(dateTime).toContain('mandag');
            expect(dateTime).toContain('august');
            expect(dateTime).toMatch(/\d{2}:\d{2}$/);

            dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows a page-supplied account status and logout button, and hides both when unset', () => {
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        pageAccountStatus.set(null);
        navigate('#/settings');
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const statusEl = container.querySelector<HTMLElement>('.masthead-account-status');
        const logoutButton = container.querySelector<HTMLButtonElement>('.masthead-account-logout');
        expect(statusEl?.style.display).toBe('none');
        expect(logoutButton?.style.display).toBe('none');

        const onLogout = vi.fn();
        pageAccountStatus.set({ text: 'Innlogget · lagrer automatisk', logoutLabel: 'Logg ut', onLogout });

        expect(statusEl?.style.display).not.toBe('none');
        expect(statusEl?.textContent).toBe('Innlogget · lagrer automatisk');
        expect(logoutButton?.textContent).toBe('Logg ut');

        logoutButton?.click();
        expect(onLogout).toHaveBeenCalledTimes(1);

        pageAccountStatus.set(null);
        expect(statusEl?.style.display).toBe('none');

        dispose();
    });

    it('opens a list of what is on the map when a count is tapped, and focuses the map on a pick', () => {
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        navigate('#/map');
        liveLayerCounts.set(counts({ ships: 2, aircraft: 1 }));
        const focus = vi.fn();
        liveLayerListing.set(
            listing(
                {
                    ships: [
                        { id: '257', label: 'ARTHUR EILERTSEN', detail: '9,6 kn', lat: 68.7, lng: 15.4 },
                        { id: '259', label: 'RO MASTER', detail: '0 kn', lat: 68.6, lng: 15.5 },
                    ],
                    aircraft: [{ id: 'abc', label: 'WIF6T', detail: '9 025 fot', lat: 68.5, lng: 16.1 }],
                },
                focus,
            ),
        );

        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const panel = container.querySelector<HTMLElement>('.masthead-live-panel');
        expect(panel?.hidden).toBe(true);

        // Tapping the ships count lists the ships, not the aircraft.
        container.querySelector<HTMLButtonElement>('.masthead-count-ships')?.closest('button')?.click();
        expect(panel?.hidden).toBe(false);
        const names = [...container.querySelectorAll('.masthead-live-row-name')].map((el) => el.textContent);
        expect(names).toEqual(['ARTHUR EILERTSEN', 'RO MASTER']);

        // Picking one focuses the map and closes the list again.
        container.querySelector<HTMLButtonElement>('.masthead-live-row')?.click();
        expect(focus).toHaveBeenCalledTimes(1);
        expect(focus.mock.calls[0]?.[0]).toMatchObject({ id: '257' });
        expect(panel?.hidden).toBe(true);

        // The other count lists its own group.
        container.querySelector<HTMLButtonElement>('.masthead-count-aircraft')?.closest('button')?.click();
        expect([...container.querySelectorAll('.masthead-live-row-name')].map((el) => el.textContent)).toEqual(['WIF6T']);

        // Tapping the same count again closes it.
        container.querySelector<HTMLButtonElement>('.masthead-count-aircraft')?.closest('button')?.click();
        expect(panel?.hidden).toBe(true);

        liveLayerCounts.set(null);
        liveLayerListing.set(null);
        dispose();
    });

    it('closes the list when the listing goes away, so it cannot outlive the map page', () => {
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        navigate('#/map');
        liveLayerCounts.set(counts({ ships: 1 }));
        liveLayerListing.set(listing({ ships: [{ id: '257', label: 'ARTHUR EILERTSEN', detail: '9,6 kn', lat: 68.7, lng: 15.4 }] }, vi.fn()));

        const container = document.createElement('div');
        const dispose = mountMasthead(container);
        container.querySelector<HTMLButtonElement>('.masthead-count-ships')?.closest('button')?.click();
        expect(container.querySelector<HTMLElement>('.masthead-live-panel')?.hidden).toBe(false);

        liveLayerListing.set(null);

        expect(container.querySelector<HTMLElement>('.masthead-live-panel')?.hidden).toBe(true);

        liveLayerCounts.set(null);
        dispose();
    });

    it('renders all seven keyed groups, each with its own numeral and unit word', () => {
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        navigate('#/map');
        liveLayerCounts.set(counts({ ships: 14, aircraft: 3, roadSituations: 6, roadCameras: 19, transit: 7, warnings: 2, species: 5 }));

        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const layerCounts = container.querySelector<HTMLElement>('.masthead-layer-counts');
        expect(layerCounts?.textContent).toContain('14 skip');
        expect(layerCounts?.textContent).toContain('3 fly');
        expect(layerCounts?.textContent).toContain('6 vegmeldinger');
        expect(layerCounts?.textContent).toContain('19 vegkamera');
        expect(layerCounts?.textContent).toContain('7 kollektiv');
        expect(layerCounts?.textContent).toContain('2 farevarsler');
        expect(layerCounts?.textContent).toContain('5 arter');

        // Each numeral in its own colour-carrying element -- the glyph
        // inside it is an `<svg>`, so it contributes no text.
        expect(container.querySelector('.masthead-count-road-situations')?.textContent).toBe('6');
        expect(container.querySelector('.masthead-count-road-cameras')?.textContent).toBe('19');
        expect(container.querySelector('.masthead-count-transit')?.textContent).toBe('7');
        expect(container.querySelector('.masthead-count-warnings')?.textContent).toBe('2');
        expect(container.querySelector('.masthead-count-species')?.textContent).toBe('5');

        // Seven interactive counts, in reading order; the hidden-by-age one
        // is not a group and opens nothing.
        const buttons = [...container.querySelectorAll('.masthead-count--interactive')];
        expect(buttons).toHaveLength(7);
        expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
            '14 skip',
            '3 fly',
            '6 vegmeldinger',
            '19 vegkamera',
            '7 kollektiv',
            '2 farevarsler',
            '5 arter',
        ]);

        liveLayerCounts.set(null);
        dispose();
    });

    it('carries a glyph per group, hidden by CSS until kiosk width -- so a dropped unit word leaves something to read', () => {
        // The unit words cannot survive 1024px with four groups in the row
        // (`shell.css`'s 1300px query -- measured: four Norwegian words
        // first fit at about 1275px), so every count has a glyph beside
        // its numeral, in the group's own colour via `currentColor`. jsdom
        // applies no media query, so what is asserted here is that the
        // glyph exists and is inside the colour-carrying element; the
        // width behaviour itself was checked in a real browser.
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        navigate('#/map');
        liveLayerCounts.set(
            counts({ ships: 1, aircraft: 1, roadSituations: 1, roadCameras: 1, transit: 1, warnings: 1, species: 1, hiddenByAge: 1 }),
        );

        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        // Seven groups plus the hidden-by-age count.
        expect(container.querySelectorAll('.masthead-count-glyph svg')).toHaveLength(8);
        for (const className of ['ships', 'aircraft', 'road-situations', 'road-cameras', 'transit', 'warnings', 'species']) {
            expect(container.querySelector(`.masthead-count-${className} .masthead-count-glyph`)).not.toBeNull();
        }
        // And the word is in its own element, which is what the media
        // query switches off.
        expect(container.querySelectorAll('.masthead-count-unit')).toHaveLength(8);

        liveLayerCounts.set(null);
        dispose();
    });

    it('opens the road-camera group, and runs an item’s own action instead of panning the map', () => {
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        navigate('#/map');
        liveLayerCounts.set(counts({ roadCameras: 1 }));
        const focus = vi.fn();
        const activate = vi.fn();
        liveLayerListing.set(
            listing({ roadCameras: [{ id: '3000957_1', label: 'Hadselbrua', detail: 'Mot Stokmarknes', lat: 68.55, lng: 14.9, activate }] }, focus),
        );

        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        container.querySelector<HTMLButtonElement>('.masthead-count-road-cameras')?.closest('button')?.click();
        expect([...container.querySelectorAll('.masthead-live-row-name')].map((el) => el.textContent)).toEqual(['Hadselbrua']);

        // A camera *is* its picture: the row opens the modal rather than
        // panning to a pin the visitor would have to find and tap.
        container.querySelector<HTMLButtonElement>('.masthead-live-row')?.click();
        expect(activate).toHaveBeenCalledTimes(1);
        expect(focus).not.toHaveBeenCalled();
        expect(container.querySelector<HTMLElement>('.masthead-live-panel')?.hidden).toBe(true);

        liveLayerCounts.set(null);
        liveLayerListing.set(null);
        dispose();
    });

    it('shows the slideshow control only while auto-cycle is switched on', () => {
        // A dead play button on a wall display is worse than no button:
        // nothing to pause, and no countdown to draw.
        autoCycleArmed.set({ armedAt: 1_000, intervalSeconds: 30 });
        setSettings({ autoCycle: { enabled: false, intervalSeconds: 30, pages: [] } });
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        expect(container.querySelector<HTMLElement>('.masthead-cycle')?.hidden).toBe(true);

        setSettings({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] } });
        expect(container.querySelector<HTMLElement>('.masthead-cycle')?.hidden).toBe(false);

        // Switched on, but with nowhere to cycle to: `startAutoCycle` arms
        // nothing, and a button that cannot make anything happen is worse
        // than no button.
        autoCycleArmed.set(null);
        expect(container.querySelector<HTMLElement>('.masthead-cycle')?.hidden).toBe(true);

        dispose();
    });

    it('pauses and resumes the slideshow, saying which it will do next', () => {
        setSettings({ autoCycle: { enabled: true, intervalSeconds: 30, pages: [] } });
        autoCyclePaused.set(false);
        autoCycleArmed.set({ armedAt: 1_000, intervalSeconds: 30 });
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const button = container.querySelector<HTMLButtonElement>('.masthead-cycle-button');
        expect(button?.getAttribute('aria-label')).toBe('Pause automatisk bla');

        button?.click();
        expect(autoCyclePaused.get()).toBe(true);
        // The label offers the way out, not a description of the state.
        expect(button?.getAttribute('aria-label')).toBe('Start automatisk bla');
        expect(container.querySelector('.masthead-cycle--paused')).not.toBeNull();

        button?.click();
        expect(autoCyclePaused.get()).toBe(false);
        expect(container.querySelector('.masthead-cycle--paused')).toBeNull();

        autoCyclePaused.set(false);
        autoCycleArmed.set(null);
        dispose();
    });

    it('draws the countdown over the interval it is actually counting', () => {
        setSettings({ autoCycle: { enabled: true, intervalSeconds: 45, pages: [] } });
        autoCyclePaused.set(false);
        autoCycleArmed.set({ armedAt: 1_000, intervalSeconds: 45 });
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const bar = container.querySelector<HTMLElement>('.masthead-cycle-bar');
        expect(bar?.style.animationDuration).toBe('45s');

        // A fresh interval has to restart the animation, which only happens
        // when the element itself is re-inserted.
        const first = bar;
        autoCycleArmed.set({ armedAt: 2_000, intervalSeconds: 45 });
        expect(container.querySelector('.masthead-cycle-bar')).toBe(first); // the same element...
        expect(first?.parentElement?.className).toBe('masthead-cycle-track'); // ...re-attached, not replaced

        autoCycleArmed.set(null);
        dispose();
    });
});
