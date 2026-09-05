/**
 * A free-text numeric input (lat/lng/zoom -- values that need arbitrary
 * decimal precision, not stepped values). Debounces writes 500ms and
 * flushes on blur/Enter, per the phase's autosave contract
 * (`src/web/settings/autosave.ts`) -- built directly on that module
 * rather than duplicating its timer logic.
 *
 * Validation is schema-driven (the actual Zod schema passed in by the
 * caller -- always a piece of `src/shared/schemas/settings.ts`, never a
 * hand-written parallel validator): an invalid keystroke shows an inline
 * error and updates the display, but `autosave.trigger()` is only ever
 * called for a value that already parsed successfully, so an invalid
 * value never reaches `write()` and therefore never calls `fetch` --
 * `flush()` on blur/Enter is then a safe no-op for a value that was never
 * triggered in the first place.
 *
 * Never recreated by its caller on a settings poll -- `update()` syncs
 * the displayed value from external state, but is a no-op while the
 * input has focus, so an in-progress edit is never clobbered by a poll
 * response arriving mid-keystroke (this is the DOM-level half of the
 * same "don't clobber an in-flight edit" guarantee `sharedStore.ts`'s
 * `pendingFields` provides at the data level).
 */
import type { ZodType } from 'zod';
import type { Result } from '../../shared/result.js';
import { autosave, type Autosave } from '../settings/autosave.js';
import { t } from '../i18n/index.js';

export interface NumberFieldOptions {
    value: number;
    schema: ZodType<number>;
    step?: string;
    disabled?: boolean;
    write: (value: number) => Promise<Result<unknown>>;
    debounceMs?: number;
}

export interface NumberFieldHandle {
    el: HTMLElement;
    input: HTMLInputElement;
    autosave: Autosave;
    update: (value: number, disabled?: boolean) => void;
}

function formatForDisplay(value: number): string {
    return String(value);
}

function parseCandidate(raw: string, schema: ZodType<number>): { valid: true; value: number } | { valid: false } {
    const normalized = raw.trim().replace(',', '.');
    if (normalized === '') return { valid: false };
    const asNumber = Number(normalized);
    if (Number.isNaN(asNumber)) return { valid: false };
    const parsed = schema.safeParse(asNumber);
    return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}

export function numberField(options: NumberFieldOptions): NumberFieldHandle {
    let committed = options.value;
    let disabled = options.disabled ?? false;

    const wrapper = document.createElement('div');
    wrapper.className = 'number-field';

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    if (options.step !== undefined) input.step = options.step;
    input.className = 'number-field-input';
    input.value = formatForDisplay(committed);
    input.disabled = disabled;

    const errorEl = document.createElement('div');
    errorEl.className = 'number-field-error';

    wrapper.append(input, errorEl);

    const engine = autosave<number>(() => committed, options.write, { debounceMs: options.debounceMs ?? 500 });

    input.addEventListener('input', () => {
        const candidate = parseCandidate(input.value, options.schema);
        if (candidate.valid) {
            errorEl.textContent = '';
            input.classList.remove('number-field-input--invalid');
            committed = candidate.value;
            engine.trigger();
        } else {
            errorEl.textContent = t('settings.validation.invalid');
            input.classList.add('number-field-input--invalid');
            // A previously-scheduled debounced write for the last valid value
            // must not fire while the field currently shows an unconfirmed,
            // invalid edit.
            engine.cancel();
        }
    });

    function revertToCommitted(): void {
        input.value = formatForDisplay(committed);
        errorEl.textContent = '';
        input.classList.remove('number-field-input--invalid');
    }

    input.addEventListener('blur', () => {
        if (input.classList.contains('number-field-input--invalid')) {
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

    function update(value: number, nextDisabled = disabled): void {
        disabled = nextDisabled;
        input.disabled = disabled;
        if (document.activeElement === input) return; // never clobber an in-progress edit
        committed = value;
        revertToCommitted();
    }

    return { el: wrapper, input, autosave: engine, update };
}
