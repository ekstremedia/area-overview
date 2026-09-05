import { describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { mountFooterLine } = await import('./FooterLine.js');
const { pageAttribution, pageFreshness } = await import('./page-status.js');

function setSettings(patch: Partial<Settings>): void {
    mockSettings.set({ ...mockSettings.get(), ...patch });
}

describe('mountFooterLine', () => {
    it('shows the attribution placeholder and no "updated" text when nothing is set', () => {
        pageAttribution.set(null);
        pageFreshness.set(null);
        setSettings({ night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' } });
        const container = document.createElement('div');
        const dispose = mountFooterLine(container);

        expect(container.querySelector('.footer-attribution')?.textContent).toBe('Kilde kommer');
        expect(container.querySelector('.footer-updated')?.textContent).toBe('');

        dispose();
    });

    it('shows a page-supplied attribution and a relative "updated" time once set', () => {
        pageAttribution.set('MET.no / Yr');
        pageFreshness.set({ fetchedAt: new Date(Date.now() - 12_000), intervalMs: 30_000 });
        setSettings({ night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' } });
        const container = document.createElement('div');
        const dispose = mountFooterLine(container);

        expect(container.querySelector('.footer-attribution')?.textContent).toBe('MET.no / Yr');
        expect(container.querySelector('.footer-updated')?.textContent).toMatch(/Oppdatert/);

        pageAttribution.set(null);
        pageFreshness.set(null);
        dispose();
    });

    it('replaces the normal footer with the night-schedule note while the schedule is active', () => {
        const now = new Date();
        const from = `${String(now.getHours()).padStart(2, '0')}:00`;
        const to = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
        setSettings({ night: { enabled: true, from, to, mode: 'dim' } });
        const container = document.createElement('div');
        const dispose = mountFooterLine(container);

        const nightNote = container.querySelector<HTMLElement>('.footer-night-note');
        expect(nightNote?.style.display).not.toBe('none');
        expect(nightNote?.textContent).toContain('Nattplan aktiv');
        expect(container.querySelector<HTMLElement>('.footer-attribution')?.style.display).toBe('none');
        expect(container.querySelector<HTMLElement>('.footer-updated')?.style.display).toBe('none');

        dispose();
    });
});
