/**
 * Norwegian (Bokmål) string table -- the source of truth for both the
 * translation *keys* and their parameter names. `en.ts` is typed against
 * this object (`Record<keyof typeof nb, string>`), so a key defined here
 * with no English counterpart is a compile error, not a silent runtime
 * gap. See `index.ts` for how `{paramName}` placeholders in a value here
 * become a typed, required parameter at every `t(key, ...)` call site.
 */
export const nb = {
    'brand.title': 'Området',

    'nav.map': 'Kart',
    'nav.weather': 'Vær',
    'nav.aurora': 'Nordlys',
    'nav.tide': 'Tidevann',
    'nav.cameras': 'Kameraer',
    'nav.settings': 'Innstillinger',

    'locality.map': 'Sortland · Vesterålen',
    'locality.weather': 'Sortland · Vesterålen',
    'locality.aurora': 'Sortland · Vesterålen',
    'locality.tide': 'Andenes · nærmeste målestasjon',
    'locality.cameras': 'To kameraer',
    'locality.settings': 'Innstillinger',

    'page.placeholderBody': 'Innhold kommer i en senere fase.',

    'masthead.stale': 'Gamle data · {duration}',
    'masthead.layerCounts': '{ships} skip · {aircraft} fly',

    'footer.attributionPlaceholder': 'Kilde kommer',
    'footer.updated': 'Oppdatert {relative}',
    'footer.nightScheduleActive': 'Nattplan aktiv {from}–{to} · ett trykk løfter sløret i 30 s',

    'unit.minutes': 'min',
    'unit.seconds': 's',
} as const;

export type TranslationKey = keyof typeof nb;
