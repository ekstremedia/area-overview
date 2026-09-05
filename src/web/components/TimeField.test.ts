import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, type Result } from '../../shared/result.js';
import { timeField } from './TimeField.js';

afterEach(() => {
    vi.useRealTimers();
});

function setValue(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('timeField', () => {
    it('flushes immediately on blur', () => {
        vi.useFakeTimers();
        const write = vi.fn<(v: string) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input } = timeField({ value: '23:00', write });
        document.body.append(input);
        input.focus();

        setValue(input, '22:30');
        expect(write).not.toHaveBeenCalled();

        input.blur();
        expect(write).toHaveBeenCalledWith('22:30');
    });

    it('debounces rapid edits into a single write of the latest value', async () => {
        vi.useFakeTimers();
        const write = vi.fn<(v: string) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input } = timeField({ value: '23:00', write });
        document.body.append(input);
        input.focus();

        setValue(input, '06:00');
        await vi.advanceTimersByTimeAsync(500);

        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('06:00');
    });

    it('an invalid HH:MM value shows an inline error and triggers zero writes', () => {
        const write = vi.fn<(v: string) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input, el } = timeField({ value: '23:00', write });
        document.body.append(input);
        input.focus();

        setValue(input, '25:99');
        expect(el.querySelector('.time-field-error')?.textContent).not.toBe('');

        input.blur();
        expect(write).not.toHaveBeenCalled();
    });

    it('update() does not clobber the input while it has focus', () => {
        const write = vi.fn<(v: string) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input, update } = timeField({ value: '23:00', write });
        document.body.append(input);
        input.focus();

        setValue(input, '01:00');
        update('12:00');

        expect(input.value).toBe('01:00');
    });
});
