/**
 * Hand-rolled i18n -- no library. `t()` reads the current language
 * reactively (via `currentLanguage`, itself derived from the settings
 * resource), so calling it inside an `effect()`/`bind()` re-renders text
 * in place the moment `settings.language` changes, no reload.
 *
 * The template-literal-types lesson: `ParamNames<K>` walks the *literal*
 * Norwegian string type for key `K` (nb.ts is declared `as const`, so its
 * values are literal string types, not just `string`) and pulls out every
 * `{name}` placeholder as a union of string literal types. `t()`'s params
 * argument is then typed from that union, so:
 *   - a key with no placeholders takes no params object at all;
 *   - a key with placeholders *requires* one, with exactly those keys;
 *   - `t('masthead.stale', { wrongName: 5 })` and `t('masthead.stale')`
 *     (params omitted) both fail `npm run typecheck`, not just at runtime.
 */
import { computed, type ReadonlySignal } from '../core/signal.js';
import { settings } from '../settings-resource.js';
import { en } from './en.js';
import { nb, type TranslationKey } from './nb.js';

export type { TranslationKey } from './nb.js';

/** The language currently selected in shared settings, reactive. */
export const currentLanguage: ReadonlySignal<'nb' | 'en'> = computed(() => settings.get().language);

/** `Intl`-ready locale tag derived from `currentLanguage`, reactive. */
export const locale: ReadonlySignal<'nb-NO' | 'en-GB'> = computed(() => (currentLanguage.get() === 'nb' ? 'nb-NO' : 'en-GB'));

type ExtractParamNames<S extends string> = S extends `${string}{${infer Param}}${infer Rest}` ? Param | ExtractParamNames<Rest> : never;

type ParamNames<K extends TranslationKey> = ExtractParamNames<(typeof nb)[K]>;

type ParamValue = string | number;

/**
 * A conditional tuple: `[]` when the key has no `{placeholder}`s (so
 * `t(key)` is valid with no second argument), a one-element tuple of the
 * exact required params otherwise (so `t(key)` alone -- and `t(key, {})`,
 * and a params object with a misspelled key -- all fail to compile).
 */
type ParamsArg<K extends TranslationKey> = [ParamNames<K>] extends [never] ? [] : [Record<ParamNames<K>, ParamValue>];

/**
 * The subset of keys with no `{placeholder}`s at all. Needed wherever a
 * key is threaded through a plain `TranslationKey`-typed variable (e.g.
 * `PageEntry.navKey` in `pages/registry.ts`) before reaching `t()`:
 * inferring `K` from a *widened* union like `TranslationKey` itself would
 * make `ParamNames<K>` distribute over every key, including ones that do
 * take params, and incorrectly demand a params argument even when the
 * specific key in hand never needs one. Typing that variable as
 * `ParamlessKey` instead keeps the inferred union restricted to members
 * that all agree on "no params", so `t(key)` with one argument compiles.
 */
export type ParamlessKey = { [K in TranslationKey]: [ParamNames<K>] extends [never] ? K : never }[TranslationKey];

function interpolate(template: string, params: Record<string, ParamValue> | undefined): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function t<K extends TranslationKey>(key: K, ...params: ParamsArg<K>): string {
    const table = currentLanguage.get() === 'nb' ? nb : en;
    const template: string = table[key];
    return interpolate(template, params[0]);
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 24 * 60 * 60],
    ['month', 30 * 24 * 60 * 60],
    ['day', 24 * 60 * 60],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1],
];

/** A fully localized "N units ago" phrase (`Intl.RelativeTimeFormat`), auto-picking the largest sensible unit. */
export function formatRelative(date: Date, now: Date = new Date()): string {
    const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
    const absSeconds = Math.abs(diffSeconds);
    const formatter = new Intl.RelativeTimeFormat(locale.get(), { numeric: 'auto', style: 'long' });
    for (const [unit, secondsInUnit] of RELATIVE_UNITS) {
        if (absSeconds >= secondsInUnit || unit === 'second') {
            return formatter.format(Math.round(diffSeconds / secondsInUnit), unit);
        }
    }
    /* istanbul ignore next -- RELATIVE_UNITS always bottoms out at 'second', which matches unconditionally above */
    return formatter.format(0, 'second');
}

/** A localized 24-hour clock time (`Intl.DateTimeFormat`). */
export function formatTime(date: Date): string {
    return new Intl.DateTimeFormat(locale.get(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/**
 * A localized number, optionally with a unit suffix. The one sanctioned
 * way to put a number on screen -- no page should concatenate a raw
 * number and a unit string by hand, since that skips locale-correct
 * decimal separators (`7,4` in nb vs `7.4` in en).
 */
export function formatNumber(n: number, unit?: string): string {
    const formatted = new Intl.NumberFormat(locale.get()).format(n);
    return unit === undefined ? formatted : `${formatted} ${unit}`;
}
