/**
 * Test-only helper: returns a shallow copy of `obj` without `key`, used by
 * the schema tests to build a "required field deleted" fixture variant
 * without introducing an unused destructured binding.
 */
export function omitKey<T extends Record<string, unknown>>(obj: T, key: keyof T): Record<string, unknown> {
    return Object.fromEntries(Object.entries(obj).filter(([entryKey]) => entryKey !== key));
}
