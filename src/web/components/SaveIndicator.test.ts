import { describe, expect, it, vi } from 'vitest';
import { saveIndicator } from './SaveIndicator.js';

describe('saveIndicator', () => {
    it('renders nothing for idle with no idleLabel', () => {
        const el = saveIndicator({ status: { kind: 'idle' } });
        expect(el.textContent).toBe('');
        expect(el.classList.contains('save-indicator--idle')).toBe(true);
    });

    it('renders the idleLabel for idle when given (e.g. placement status)', () => {
        const el = saveIndicator({ status: { kind: 'idle' }, idleLabel: 'Uten plassering' });
        expect(el.textContent).toBe('Uten plassering');
    });

    it('renders "Lagrer…" for saving', () => {
        const el = saveIndicator({ status: { kind: 'saving' } });
        expect(el.textContent).toBe('Lagrer…');
    });

    it('renders "Venter…" for pending', () => {
        const el = saveIndicator({ status: { kind: 'pending' } });
        expect(el.textContent).toBe('Venter…');
    });

    it('renders "Lagret" for saved', () => {
        const el = saveIndicator({ status: { kind: 'saved' } });
        expect(el.textContent).toBe('Lagret');
        expect(el.classList.contains('save-indicator--saved')).toBe(true);
    });

    it('renders an error message and a retry button that calls retry()', () => {
        const retry = vi.fn();
        const el = saveIndicator({ status: { kind: 'error', message: 'boom', retry } });

        expect(el.classList.contains('save-indicator--error')).toBe(true);
        const button = el.querySelector<HTMLButtonElement>('.save-indicator-retry');
        expect(button?.textContent).toBe('Prøv igjen');

        button?.click();
        expect(retry).toHaveBeenCalledTimes(1);
    });
});
