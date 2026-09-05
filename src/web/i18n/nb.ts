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
    'unit.metersPerSecond': 'm/s',
    'unit.millimeters': 'mm',

    'map.unplacedLink': '{count} kamera uten plassering →',
    'map.popupClose': 'Lukk',
    'map.noImage': 'Intet bilde ennå',
    'map.cameraImageAlt': 'Bilde fra {name}',
    'map.openCamera': 'Åpne kamera →',
    'map.pointForecastLabel': 'Punktvarsel',
    'map.pointForecastLoading': 'Henter …',
    'map.pointForecastError': 'Kunne ikke hente værvarsel.',
    'map.pointForecastRetry': 'Prøv igjen',
    'map.pointForecastCondition': '{condition}, {direction}',
    'map.pointForecastStats': '{wind} · {precip} · {lat} / {lng}',

    'symbol.clearsky': 'klarvær',
    'symbol.fair': 'lettskyet',
    'symbol.partlycloudy': 'delvis skyet',
    'symbol.cloudy': 'skyet',
    'symbol.fog': 'tåke',
    'symbol.rain': 'regn',
    'symbol.lightrain': 'lett regn',
    'symbol.heavyrain': 'kraftig regn',
    'symbol.rainshowers': 'regnbyger',
    'symbol.sleet': 'sludd',
    'symbol.snow': 'snø',
    'symbol.lightsnow': 'lett snø',
    'symbol.heavysnow': 'kraftig snø',

    'compass.n': 'nord',
    'compass.ne': 'nordøst',
    'compass.e': 'øst',
    'compass.se': 'sørøst',
    'compass.s': 'sør',
    'compass.sw': 'sørvest',
    'compass.w': 'vest',
    'compass.nw': 'nordvest',
} as const;

export type TranslationKey = keyof typeof nb;
