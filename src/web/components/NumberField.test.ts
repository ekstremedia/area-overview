import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ok, type Result } from '../../shared/result.js';
import { numberField } from './NumberField.js';

const LAT_SCHEMA = z.number().min(-90).max(90);

afterEach(() => {
    vi.useRealTimers();
});

function setValue(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('numberField', () => {
    it('debounces writes 500ms and coalesces rapid keystrokes into one write of the latest value', async () => {
        vi.useFakeTimers();
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        document.body.append(input);
        input.focus();

        setValue(input, '68.7');
        await vi.advanceTimersByTimeAsync(100);
        setValue(input, '68.72');
        await vi.advanceTimersByTimeAsync(100);
        setValue(input, '68.720');

        expect(write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);

        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(68.72);
    });

    it('flushes immediately on blur, without waiting out the debounce window', () => {
        vi.useFakeTimers();
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        document.body.append(input);
        input.focus();

        setValue(input, '68.75');
        expect(write).not.toHaveBeenCalled();

        input.blur();
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(68.75);
    });

    it('flushes immediately on Enter', () => {
        vi.useFakeTimers();
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        document.body.append(input);
        input.focus();

        setValue(input, '68.9');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(68.9);
    });

    it('an out-of-range value shows an inline error and triggers zero writes', () => {
        vi.useFakeTimers();
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input, el } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        document.body.append(input);
        input.focus();

        setValue(input, '190');
        expect(el.querySelector('.number-field-error')?.textContent).not.toBe('');
        expect(input.classList.contains('number-field-input--invalid')).toBe(true);

        input.blur();
        expect(write).not.toHaveBeenCalled();
    });

    it('a non-numeric value shows an inline error and triggers zero writes', () => {
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        document.body.append(input);
        input.focus();

        setValue(input, 'abc');
        input.blur();

        expect(write).not.toHaveBeenCalled();
    });

    it('accepts a comma as the decimal separator', () => {
        vi.useFakeTimers();
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        document.body.append(input);
        input.focus();

        setValue(input, '68,72');
        input.blur();

        expect(write).toHaveBeenCalledWith(68.72);
    });

    it('an invalid edit cancels a previously-scheduled valid debounced write', async () => {
        vi.useFakeTimers();
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        document.body.append(input);
        input.focus();

        setValue(input, '10'); // valid -- schedules a debounced write of 10
        await vi.advanceTimersByTimeAsync(100); // well within the 500ms debounce window

        setValue(input, '190'); // now invalid (out of range) -- must cancel the pending write
        await vi.advanceTimersByTimeAsync(1000); // long past when the original debounce would have fired

        expect(write).not.toHaveBeenCalled();

        // A subsequent valid edit still writes, with only its own value.
        setValue(input, '42');
        await vi.advanceTimersByTimeAsync(500);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(42);
    });

    it('update() does not clobber the input while it has focus', () => {
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input, update } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        document.body.append(input);
        input.focus();

        setValue(input, '68.9');
        update(50); // simulating a poll response arriving mid-edit

        expect(input.value).toBe('68.9');
    });

    it('renders the input with a unique id/name when given an explicit id', () => {
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const a = numberField({ value: 68.7, schema: LAT_SCHEMA, write, id: 'camera-a-lat' });
        const b = numberField({ value: 15.4, schema: LAT_SCHEMA, write, id: 'camera-b-lat' });

        expect(a.input.id).toBe('camera-a-lat');
        expect(a.input.name).toBe('camera-a-lat');
        expect(b.input.id).toBe('camera-b-lat');
        expect(b.input.name).toBe('camera-b-lat');
        expect(a.input.id).not.toBe(b.input.id);
        expect(a.input.name).not.toBe(b.input.name);
    });

    it('falls back to a non-empty, unique id/name when none is given', () => {
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const a = numberField({ value: 68.7, schema: LAT_SCHEMA, write });
        const b = numberField({ value: 15.4, schema: LAT_SCHEMA, write });

        expect(a.input.id).not.toBe('');
        expect(a.input.name).not.toBe('');
        expect(a.input.id).toBe(a.input.name);
        expect(b.input.id).toBe(b.input.name);
        expect(a.input.id).not.toBe(b.input.id);
        expect(a.input.name).not.toBe(b.input.name);
    });

    it('update() syncs the displayed value when the input is not focused', () => {
        const write = vi.fn<(v: number) => Promise<Result<unknown>>>().mockResolvedValue(ok(undefined));
        const { input, update } = numberField({ value: 68.7, schema: LAT_SCHEMA, write });

        update(50);

        expect(input.value).toBe('50');
    });
});
