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

let fallbackIdCounter = 0;

/** A reasonably-unique fallback id, for a caller that has no natural unique key to hand. */
function nextFallbackId(): string {
    fallbackIdCounter += 1;
    return `time-field-${String(fallbackIdCounter)}`;
}

export interface TimeFieldOptions {
    value: string;
    disabled?: boolean;
    write: (value: string) => Promise<Result<unknown>>;
    debounceMs?: number;
    /**
     * A unique id for the rendered `<input>` (also used as its `name`) --
     * see `NumberField.ts`'s identical option for why this matters (more
     * than one instance of this component can exist on a page). Falls back
     * to a module-local counter when omitted.
     */
    id?: string;
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
    // 'decimal', not the more semantically apt 'numeric': `OnScreenKeyboard`'s
    // layout rule keys off `inputmode="decimal"` to pick the numeric keypad,
    // and an HH:MM field should get that same keypad on this kiosk rather
    // than the full alphanumeric layout -- see that module's doc comment.
    input.inputMode = 'decimal';
    input.className = 'time-field-input';
    const id = options.id ?? nextFallbackId();
    input.id = id;
    input.name = id;
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
            // A previously-scheduled debounced write for the last valid value
            // must not fire while the field currently shows an unconfirmed,
            // invalid edit.
            engine.cancel();
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
