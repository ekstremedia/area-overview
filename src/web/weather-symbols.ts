/**
 * Yr `symbol_code` and wind-direction humanization, used by the weather
 * page (`pages/WeatherPage.ts`). It lived in the map's point-forecast
 * panel first and was extracted here to be shared; that panel is gone
 * now, but this stays its own module -- the table is data, not page
 * layout, and the weather page reads better without it inlined.
 */
import { t, type ParamlessKey } from './i18n/index.js';

const COMPASS_KEYS: readonly ParamlessKey[] = [
    'compass.n',
    'compass.ne',
    'compass.e',
    'compass.se',
    'compass.s',
    'compass.sw',
    'compass.w',
    'compass.nw',
];

/** An 8-point compass word for a wind direction in degrees (0=N, 90=E, ...). */
export function compassWord(degrees: number): string {
    const normalized = ((degrees % 360) + 360) % 360;
    const index = Math.round(normalized / 45) % 8;
    return t(COMPASS_KEYS[index] ?? 'compass.n');
}

/**
 * A best-effort, deliberately non-exhaustive humanization of MET Norway's
 * Yr `symbol_code` vocabulary (~50 codes) into a short condition fragment
 * (e.g. "lett regn" for `lightrain_day`). Anything not in this small table
 * falls back to a humanized version of the raw code (underscores to
 * spaces, day/night/twilight suffix stripped) rather than a translated
 * word.
 */
const SYMBOL_CONDITION_KEYS: Record<string, ParamlessKey> = {
    clearsky: 'symbol.clearsky',
    fair: 'symbol.fair',
    partlycloudy: 'symbol.partlycloudy',
    cloudy: 'symbol.cloudy',
    fog: 'symbol.fog',
    rain: 'symbol.rain',
    lightrain: 'symbol.lightrain',
    heavyrain: 'symbol.heavyrain',
    rainshowers: 'symbol.rainshowers',
    sleet: 'symbol.sleet',
    snow: 'symbol.snow',
    lightsnow: 'symbol.lightsnow',
    heavysnow: 'symbol.heavysnow',
};

export function humanizeSymbolCode(symbolCode: string): string {
    const base = symbolCode.replace(/_(day|night|polartwilight)$/, '');
    const key = SYMBOL_CONDITION_KEYS[base];
    if (key) return t(key);
    return base.replace(/_/g, ' ');
}
