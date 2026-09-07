/**
 * A switch-style boolean control (design tokens: 62×34px track, 28px
 * knob -- see `components.css`). Writes immediately on every tap, per
 * the phase's "toggles write immediately" requirement -- the caller's
 * `onChange` is expected to update the underlying value AND call an
 * `Autosave`'s `trigger()` synchronously, same shot.
 *
 * Built once by its caller and updated via `setState(...)` rather than
 * torn down and recreated on every settings poll -- recreating it would
 * be harmless for a toggle specifically (no focus/typed-text to lose),
 * but every settings control in this app follows the same
 * build-once/`setState()` shape for consistency and so a toggle can live
 * inside a larger row that does care about not losing focus.
 */
export interface ToggleOptions {
    label?: string;
    /** Accessible name for callers that render the visible label outside this component (e.g. via a `field()` wrapper) instead of passing `label` -- without one of the two, the switch has no accessible name at all. Ignored when `label` is set, since that already becomes the `aria-label`. */
    accessibleLabel?: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
}

export interface ToggleHandle {
    el: HTMLElement;
    setState(checked: boolean, disabled?: boolean): void;
}

export function toggle(options: ToggleOptions): ToggleHandle {
    const root = document.createElement('div');
    root.className = 'toggle-row';

    let label: HTMLElement | undefined;
    if (options.label !== undefined) {
        label = document.createElement('span');
        label.className = 'toggle-label';
        label.textContent = options.label;
        root.append(label);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle';
    button.setAttribute('role', 'switch');
    if (options.label !== undefined) button.setAttribute('aria-label', options.label);
    else if (options.accessibleLabel !== undefined) button.setAttribute('aria-label', options.accessibleLabel);

    const knob = document.createElement('span');
    knob.className = 'toggle-knob';
    button.append(knob);
    root.append(button);

    let checked = options.checked;
    let disabled = options.disabled ?? false;

    function render(): void {
        button.classList.toggle('toggle--on', checked);
        button.setAttribute('aria-checked', String(checked));
        button.disabled = disabled;
    }
    render();

    button.addEventListener('click', () => {
        if (disabled) return;
        checked = !checked;
        render();
        options.onChange(checked);
    });

    function setState(nextChecked: boolean, nextDisabled = false): void {
        checked = nextChecked;
        disabled = nextDisabled;
        render();
    }

    return { el: root, setState };
}
