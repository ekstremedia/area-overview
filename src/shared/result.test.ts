import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from './result.js';

describe('ok', () => {
    it('wraps a value in a successful Result', () => {
        const result = ok(42);
        expect(result).toEqual({ ok: true, value: 42 });
    });
});

describe('err', () => {
    it('wraps an error in a failed Result', () => {
        const result = err({ message: 'upstream timed out' });
        expect(result).toEqual({ ok: false, error: { message: 'upstream timed out' } });
    });
});

describe('Result discriminated union narrowing', () => {
    function describeResult(result: Result<number>): string {
        if (result.ok) {
            // `result.value` is only accessible once `result.ok` narrows the union.
            return `value: ${String(result.value)}`;
        }
        // `result.error` is only accessible in the other branch.
        return `error: ${result.error.message}`;
    }

    it('narrows to the value branch when ok is true', () => {
        expect(describeResult(ok(7))).toBe('value: 7');
    });

    it('narrows to the error branch when ok is false', () => {
        expect(describeResult(err({ message: 'boom' }))).toBe('error: boom');
    });
});
