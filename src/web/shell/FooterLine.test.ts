import { describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { mountFooterLine } = await import('./FooterLine.js');
const { pageAttribution } = await import('./page-status.js');

function setSettings(patch: Partial<Settings>): void {
    mockSettings.set({ ...mockSettings.get(), ...patch });
}

describe('mountFooterLine', () => {
    it('shows an empty footer, not a placeholder, when the page has nothing to credit', () => {
        pageAttribution.set(null);
        setSettings({ night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' } });
        const container = document.createElement('div');
        const dispose = mountFooterLine(container);

        // "Kilde kommer" is gone with the rest of the placeholder chrome: a
        // page with nothing to credit (the cameras page, whose images are
        // Terje's own) simply shows nothing.
        expect(container.querySelector('.footer-attribution')?.textContent).toBe('');
        // The relative "Oppdatert ... siden" half is gone entirely.
        expect(container.querySelector('.footer-updated')).toBeNull();

        dispose();
    });

    it('shows a page-supplied attribution once set', () => {
        pageAttribution.set('MET.no / Yr');
        setSettings({ night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' } });
        const container = document.createElement('div');
        const dispose = mountFooterLine(container);

        expect(container.querySelector('.footer-attribution')?.textContent).toBe('MET.no / Yr');

        pageAttribution.set(null);
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

        dispose();
    });
});
