import { describe, expect, it, vi } from 'vitest';
import { stepper } from './Stepper.js';

describe('stepper', () => {
    it('renders the formatted value', () => {
        const handle = stepper({ value: 300, min: 0, max: 3600, step: 30, formatValue: (v) => `${String(v)} s`, onChange: vi.fn() });
        expect(handle.el.querySelector('.stepper-value')?.textContent).toBe('300 s');
    });

    it('formatValue can special-case a value (e.g. 0 = "av")', () => {
        const handle = stepper({
            value: 0,
            min: 0,
            max: 3600,
            step: 30,
            formatValue: (v) => (v === 0 ? 'av' : `${String(v)} s`),
            onChange: vi.fn(),
        });
        expect(handle.el.querySelector('.stepper-value')?.textContent).toBe('av');
    });

    it('increments/decrements by step and calls onChange immediately, once per click', () => {
        const onChange = vi.fn();
        const handle = stepper({ value: 50, min: 0, max: 100, step: 10, formatValue: String, onChange });

        handle.el.querySelector<HTMLButtonElement>('.stepper-button--increment')?.click();
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(60);

        handle.el.querySelector<HTMLButtonElement>('.stepper-button--decrement')?.click();
        expect(onChange).toHaveBeenCalledTimes(2);
        expect(onChange).toHaveBeenCalledWith(50);
    });

    it('clamps at min/max and disables the corresponding button, without calling onChange past the bound', () => {
        const onChange = vi.fn();
        const handle = stepper({ value: 100, min: 0, max: 100, step: 10, formatValue: String, onChange });

        const incrementButton = handle.el.querySelector<HTMLButtonElement>('.stepper-button--increment');
        expect(incrementButton?.disabled).toBe(true);

        incrementButton?.click();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('avoids float drift on fractional steps (font scale: 0.1 steps)', () => {
        const onChange = vi.fn();
        const handle = stepper({ value: 0.8, min: 0.8, max: 1.6, step: 0.1, formatValue: String, onChange });

        for (let i = 0; i < 3; i++) handle.el.querySelector<HTMLButtonElement>('.stepper-button--increment')?.click();

        expect(onChange).toHaveBeenLastCalledWith(1.1);
    });

    it('setState updates the rendered value and disabled state without recreating the element', () => {
        const handle = stepper({ value: 50, min: 0, max: 100, step: 10, formatValue: String, onChange: vi.fn() });
        const valueEl = handle.el.querySelector('.stepper-value');

        handle.setState(80, true);

        expect(valueEl?.textContent).toBe('80');
        expect(handle.el.querySelector<HTMLButtonElement>('.stepper-button--increment')?.disabled).toBe(true);
        expect(handle.el.querySelector('.stepper-value')).toBe(valueEl);
    });
});
