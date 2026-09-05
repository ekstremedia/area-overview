/**
 * An `HH:MM` text input (night schedule's `from`/`to`) -- a plain text
 * input rather than a native `<input type="time">`, so it renders in this
 * app's own dark, serif-numeral style rather than the browser's native
 * time-picker chrome, and so `OnScreenKeyboard.ts` can write into it the
 * same way it writes into any other text input. Same debounce/flush-on-
 * blur/Enter and never-clobber-while-focused shape as `NumberField`.
 */
import type { Result } from '../../shared/result.js';
import { autosave, type Autosave } from '../settings/autosave.js';
import { t } from '../i18n/index.js';

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface TimeFieldOptions {
    value: string;
    disabled?: boolean;
    write: (value: string) => Promise<Result<unknown>>;
    debounceMs?: number;
}

export interface TimeFieldHandle {
    el: HTMLElement;
    input: HTMLInputElement;
    autosave: Autosave;
    update: (value: string, disabled?: boolean) => void;
}

export function timeField(options: TimeFieldOptions): TimeFieldHandle {
    let committed = options.value;
    let disabled = options.disabled ?? false;

    const wrapper = document.createElement('div');
    wrapper.className = 'time-field';

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.className = 'time-field-input';
    input.value = committed;
    input.placeholder = 'HH:MM';
    input.disabled = disabled;

    const errorEl = document.createElement('div');
    errorEl.className = 'time-field-error';

    wrapper.append(input, errorEl);

    const engine = autosave<string>(() => committed, options.write, { debounceMs: options.debounceMs ?? 500 });

    input.addEventListener('input', () => {
        if (HHMM_PATTERN.test(input.value)) {
            errorEl.textContent = '';
            input.classList.remove('time-field-input--invalid');
            committed = input.value;
            engine.trigger();
        } else {
            errorEl.textContent = t('settings.validation.invalid');
            input.classList.add('time-field-input--invalid');
        }
    });

    function revertToCommitted(): void {
        input.value = committed;
        errorEl.textContent = '';
        input.classList.remove('time-field-input--invalid');
    }

    input.addEventListener('blur', () => {
        if (input.classList.contains('time-field-input--invalid')) {
            revertToCommitted();
        }
        engine.flush();
    });

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            input.blur();
        }
    });

    function update(value: string, nextDisabled = disabled): void {
        disabled = nextDisabled;
        input.disabled = disabled;
        if (document.activeElement === input) return;
        committed = value;
        revertToCommitted();
    }

    return { el: wrapper, input, autosave: engine, update };
}
