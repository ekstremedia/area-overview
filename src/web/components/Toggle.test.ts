import { describe, expect, it, vi } from 'vitest';
import { toggle } from './Toggle.js';

describe('toggle', () => {
    it('renders a label and the initial checked state', () => {
        const handle = toggle({ label: 'Skip · AIS', checked: true, onChange: vi.fn() });

        expect(handle.el.querySelector('.toggle-label')?.textContent).toBe('Skip · AIS');
        const button = handle.el.querySelector<HTMLButtonElement>('.toggle');
        expect(button?.classList.contains('toggle--on')).toBe(true);
        expect(button?.getAttribute('aria-checked')).toBe('true');
    });

    it('calls onChange with the flipped value exactly once per click, synchronously (no debounce)', () => {
        const onChange = vi.fn();
        const handle = toggle({ checked: false, onChange });

        handle.el.querySelector<HTMLButtonElement>('.toggle')?.click();

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it('does not call onChange while disabled', () => {
        const onChange = vi.fn();
        const handle = toggle({ checked: false, disabled: true, onChange });

        handle.el.querySelector<HTMLButtonElement>('.toggle')?.click();

        expect(onChange).not.toHaveBeenCalled();
    });

    it('setState updates the rendered state without recreating the element', () => {
        const handle = toggle({ checked: false, onChange: vi.fn() });
        const button = handle.el.querySelector<HTMLButtonElement>('.toggle');

        handle.setState(true);

        expect(button?.classList.contains('toggle--on')).toBe(true);
        expect(handle.el.querySelector('.toggle')).toBe(button); // same node, not recreated
    });
});
