/**
 * What to call the column of current readings, given where they actually
 * came from.
 *
 * It used to be the hardcoded string "Netatmo · ute". That was already
 * wrong whenever the station was offline -- the page said "Netatmo" above
 * values Yr had supplied -- and the Netatmo gate makes it wrong for every
 * logged-out visitor on a public site, which is most of them.
 *
 * So it is derived from the payload's own per-field `source` markers
 * instead.
 */
import type { Weather } from '../shared/schemas/weather.js';

export type WeatherSourceKey = 'weather.sourceNetatmo' | 'weather.sourceYr' | 'weather.sourceMixed';

/**
 * `current.source` is not consulted: it reads `"mixed"` even in the real
 * captured response where every sub-field is Yr's, so it describes the
 * document rather than this column. The per-field markers are what
 * actually say where these numbers came from.
 */
export function currentSourceKey(current: Weather['current']): WeatherSourceKey {
    const sources = [current.temperature.source, current.humidity.source, current.pressure.source, current.wind.source, current.conditions.source];

    const hasNetatmo = sources.includes('netatmo');
    if (!hasNetatmo) return 'weather.sourceYr';

    // `conditions` is always Yr's (a symbol code is a forecast, not a
    // measurement), so a station that is up still produces a genuine
    // mixture rather than a pure "netatmo" column.
    const allNetatmo = sources.every((source) => source === 'netatmo');
    return allNetatmo ? 'weather.sourceNetatmo' : 'weather.sourceMixed';
}
