/**
 * A −/+ button pair around a numeral (artboard 07: idle reset, brightness).
 * Every stepped-numeric setting in this app uses this, never a free-text
 * input -- writes immediately per tap, same as `Toggle`.
 */
export interface StepperOptions {
    value: number;
    min: number;
    max: number;
    step: number;
    disabled?: boolean;
    /** Formats the numeral for display, e.g. `(v) => v === 0 ? 'av' : \`${v} s\`` for idle reset's "0 = off" case. */
    formatValue: (value: number) => string;
    onChange: (next: number) => void;
}

export interface StepperHandle {
    el: HTMLElement;
    setState(value: number, disabled?: boolean): void;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Rounds to 2 decimal places -- steppers with fractional steps (e.g. font scale's 0.1) would otherwise drift via plain float addition (0.8 + 0.1 * 3 !== 1.1). */
function roundToHundredths(value: number): number {
    return Math.round(value * 100) / 100;
}

export function stepper(options: StepperOptions): StepperHandle {
    const root = document.createElement('div');
    root.className = 'stepper';

    const decrementButton = document.createElement('button');
    decrementButton.type = 'button';
    decrementButton.className = 'stepper-button stepper-button--decrement';
    decrementButton.textContent = '−';
    decrementButton.setAttribute('aria-label', 'decrement');

    const valueEl = document.createElement('div');
    valueEl.className = 'stepper-value';

    const incrementButton = document.createElement('button');
    incrementButton.type = 'button';
    incrementButton.className = 'stepper-button stepper-button--increment';
    incrementButton.textContent = '+';
    incrementButton.setAttribute('aria-label', 'increment');

    root.append(decrementButton, valueEl, incrementButton);

    let value = options.value;
    let disabled = options.disabled ?? false;

    function render(): void {
        valueEl.textContent = options.formatValue(value);
        decrementButton.disabled = disabled || value <= options.min;
        incrementButton.disabled = disabled || value >= options.max;
    }
    render();

    function change(delta: number): void {
        if (disabled) return;
        const next = roundToHundredths(clamp(value + delta, options.min, options.max));
        if (next === value) return;
        value = next;
        render();
        options.onChange(value);
    }

    decrementButton.addEventListener('click', () => {
        change(-options.step);
    });
    incrementButton.addEventListener('click', () => {
        change(options.step);
    });

    function setState(nextValue: number, nextDisabled = false): void {
        value = nextValue;
        disabled = nextDisabled;
        render();
    }

    return { el: root, setState };
}
