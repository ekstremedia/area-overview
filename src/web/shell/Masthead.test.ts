import { describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { mountMasthead } = await import('./Masthead.js');
const { liveLayerCounts, pageAccountStatus, pageFreshness, pageLocalityOverride } = await import('./page-status.js');

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

    it('shows a page-supplied locality override in place of the static localityKey text, and clears it when unset', () => {
        setSettings({ enabledPages: ['map', 'weather', 'aurora', 'tide', 'cameras'] });
        pageLocalityOverride.set(null);
        navigate('#/cameras');
        const container = document.createElement('div');
        const dispose = mountMasthead(container);

        const locality = container.querySelector<HTMLElement>('.masthead-locality');
        expect(locality?.textContent).toBe('To kameraer');

        pageLocalityOverride.set('Tre kameraer');
        expect(locality?.textContent).toBe('Tre kameraer');

        pageLocalityOverride.set(null);
        expect(locality?.textContent).toBe('To kameraer');

        dispose();
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
});
