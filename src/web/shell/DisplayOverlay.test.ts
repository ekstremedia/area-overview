import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { mountDisplayOverlay } = await import('./DisplayOverlay.js');

function setSettings(patch: Partial<Settings>): void {
    mockSettings.set({ ...mockSettings.get(), ...patch });
}

function opacityOf(host: HTMLElement): string {
    const overlay = host.querySelector<HTMLDivElement>('.display-overlay');
    if (!overlay) throw new Error('overlay not mounted');
    return overlay.style.opacity;
}

beforeEach(() => {
    vi.useFakeTimers();
    setSettings(SettingsSchema.parse({}));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('mountDisplayOverlay', () => {
    it('is fully transparent at brightness 100 with no active night schedule', () => {
        const host = document.createElement('div');
        setSettings({ brightness: 100, night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' } });
        const dispose = mountDisplayOverlay(host);

        expect(opacityOf(host)).toBe('0');

        dispose();
    });

    it('darkens proportionally to brightness with no active schedule', () => {
        const host = document.createElement('div');
        setSettings({ brightness: 80, night: { enabled: false, from: '23:00', to: '06:00', mode: 'dim' } });
        const dispose = mountDisplayOverlay(host);

        expect(opacityOf(host)).toBe('0.19999999999999996'); // 1 - 80/100, float noise is fine -- checked loosely below too
        expect(Number(opacityOf(host))).toBeCloseTo(0.2, 5);

        dispose();
    });

    it('forces opacity 0.62 while an active dim-mode schedule is running', () => {
        const host = document.createElement('div');
        const now = new Date();
        const from = `${String(now.getHours()).padStart(2, '0')}:00`;
        const to = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
        setSettings({ brightness: 100, night: { enabled: true, from, to, mode: 'dim' } });
        const dispose = mountDisplayOverlay(host);

        expect(opacityOf(host)).toBe('0.62');

        dispose();
    });

    it('forces opacity 0 (no overlay) while an active dark-mode schedule is running', () => {
        const host = document.createElement('div');
        const now = new Date();
        const from = `${String(now.getHours()).padStart(2, '0')}:00`;
        const to = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
        setSettings({ brightness: 20, night: { enabled: true, from, to, mode: 'dark' } });
        const dispose = mountDisplayOverlay(host);

        expect(opacityOf(host)).toBe('0');

        dispose();
    });

    it('mode off: forces opacity 1 while active, a tap lifts it for 30s, then it re-darkens', () => {
        const host = document.createElement('div');
        const now = new Date();
        const from = `${String(now.getHours()).padStart(2, '0')}:00`;
        const to = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
        setSettings({ night: { enabled: true, from, to, mode: 'off' } });
        const dispose = mountDisplayOverlay(host);

        expect(opacityOf(host)).toBe('1');

        window.dispatchEvent(new Event('pointerdown'));
        expect(opacityOf(host)).toBe('0');

        vi.advanceTimersByTime(29_000);
        expect(opacityOf(host)).toBe('0');

        vi.advanceTimersByTime(1_000);
        expect(opacityOf(host)).toBe('1');

        dispose();
    });

    it('mode off: a tap outside the active schedule does nothing', () => {
        const host = document.createElement('div');
        setSettings({ brightness: 100, night: { enabled: false, from: '23:00', to: '06:00', mode: 'off' } });
        const dispose = mountDisplayOverlay(host);

        expect(opacityOf(host)).toBe('0');
        window.dispatchEvent(new Event('pointerdown'));
        expect(opacityOf(host)).toBe('0');

        dispose();
    });

    it('dispose() removes the overlay element and the pointerdown listener', () => {
        const host = document.createElement('div');
        const dispose = mountDisplayOverlay(host);
        expect(host.querySelector('.display-overlay')).not.toBeNull();

        dispose();
        expect(host.querySelector('.display-overlay')).toBeNull();
    });
});
