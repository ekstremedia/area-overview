/**
 * A small fixed set of choices rendered as a segmented row of tiles
 * (theme, night mode, language) -- per the design's "segmented choices
 * are 44px cells" pattern, not a native `<select>`. Writes immediately
 * per tap, like `Toggle`/`Stepper`.
 */
export interface SelectFieldOption<T extends string> {
    value: T;
    label: string;
}

export interface SelectFieldOptions<T extends string> {
    value: T;
    options: readonly SelectFieldOption<T>[];
    disabled?: boolean;
    onChange: (next: T) => void;
}

export interface SelectFieldHandle<T extends string> {
    el: HTMLElement;
    setState(value: T, disabled?: boolean): void;
}

export function selectField<T extends string>(options: SelectFieldOptions<T>): SelectFieldHandle<T> {
    const root = document.createElement('div');
    root.className = 'select-field';

    let value = options.value;
    let disabled = options.disabled ?? false;

    const buttons = options.options.map((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'select-field-tile';
        button.textContent = option.label;
        button.addEventListener('click', () => {
            if (disabled || value === option.value) return;
            value = option.value;
            render();
            options.onChange(value);
        });
        root.append(button);
        return { option, button };
    });

    function render(): void {
        for (const { option, button } of buttons) {
            button.classList.toggle('select-field-tile--active', option.value === value);
            button.disabled = disabled;
        }
    }
    render();

    function setState(nextValue: T, nextDisabled = false): void {
        value = nextValue;
        disabled = nextDisabled;
        render();
    }

    return { el: root, setState };
}
