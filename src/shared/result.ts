/**
 * The error-handling primitive used at module boundaries across this
 * codebase: expected failures (timeouts, upstream errors, validation
 * failures) become `Result` values, never thrown exceptions.
 */

export interface ApiError {
    message: string;
    cause?: unknown;
}

export type Result<T, E = ApiError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
    return { ok: false, error };
}
