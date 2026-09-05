import { describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { mountMasthead } = await import('./Masthead.js');
const { liveLayerCounts, pageFreshness } = await import('./page-status.js');

function navigate(hash: string): void {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function setSettings(patch: Partial<Settings>): void {
    mockSettings.set({ ...mockSettings.get(), ...patch });
}

describe('mountMasthead', () => {
    it('renders the brand, five tabs and the Settings link, marking the active tab', () => {
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        navigate('#/weather');
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        expect(container.querySelector('.masthead-brand')?.textContent).toBe('Området');

        const tabs = [...container.querySelectorAll<HTMLAnchorElement>('.masthead-tab')];
        expect(tabs.map((tab) => tab.textContent)).toEqual(['Kart', 'Vær', 'Nordlys', 'Tidevann', 'Kameraer']);

        const activeTab = container.querySelector('.masthead-tab--active');
        expect(activeTab?.textContent).toBe('Vær');
        expect(activeTab?.getAttribute('href')).toBe('#/weather');

        const settingsLink = container.querySelector<HTMLAnchorElement>('.masthead-settings-link');
        expect(settingsLink?.textContent).toBe('Innstillinger');
        expect(settingsLink?.getAttribute('href')).toBe('#/settings');

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

        liveLayerCounts.set({ ships: 14, aircraft: 3 });
        expect(layerCounts?.style.display).not.toBe('none');
        expect(layerCounts?.textContent).toBe('14 skip · 3 fly');

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

            const clock = container.querySelector<HTMLElement>('.masthead-clock');
            const initialText = clock?.textContent;

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
});
