/**
 * Rebuilds a weather document's `current` block from Yr alone, dropping
 * every reading that came from Terje's own Netatmo station.
 *
 * The station is in his house. Its live temperature, humidity and rain
 * are personal in a way a public forecast is not, so on a public site
 * they are shown only to a device that holds the settings password (see
 * `server/routes/weather.ts` for the three conditions).
 *
 * The upstream offers no flag for this -- verified against the live API,
 * which merges Netatmo into `current` even for coordinates in Oslo -- so
 * the strip happens here.
 *
 * **The contract is the already-captured
 * `fixtures/weather-netatmo-offline.json`**: a real response recorded
 * while the station was genuinely offline. `stripNetatmo` applied to it
 * must return it unchanged, which pins every detail of what a Yr-only
 * `current` looks like, including two that are easy to get wrong:
 *
 * - `wind.speed`/`wind.gust` are **km/h**, while `yr.current.wind_speed`
 *   is m/s. Upstream converts; so must this, or the page would report a
 *   gale as a breeze.
 * - `rain` keeps only its `source`. The three measurements under it come
 *   from the Netatmo rain gauge specifically, and `min`/`max`/`trend` on
 *   temperature and pressure are Netatmo-derived too.
 *
 * Returns `null` when `yr.current` cannot be read. The caller must fail
 * closed on that: serving the original document would leak exactly what
 * this function exists to remove.
 */
import { z } from 'zod';
import type { Weather } from '../schemas/weather.js';

/** Upstream reports `current.wind` in km/h and `yr.current.wind_speed` in m/s. */
const MS_TO_KMH = 3.6;

/**
 * Only the fields a Yr-only `current` is built from. Tolerant by design:
 * `yr` is otherwise passed through unvalidated (see `WeatherSchema`), and
 * a missing optional field here should cost that one reading rather than
 * the whole response.
 */
const YrCurrentSchema = z.object({
    temperature: z.number(),
    humidity: z.number(),
    pressure: z.number(),
    wind_speed: z.number(),
    wind_direction: z.number(),
    wind_gust: z.number().nullish(),
    cloud_coverage: z.number().nullish(),
    uv_index: z.number().nullish(),
    dew_point: z.number().nullish(),
    fog: z.number().nullish(),
    symbol_code: z.string(),
});

/** Drops a key entirely when the value is absent, rather than writing `undefined` into it -- an own-but-undefined key serialises differently from a missing one. */
function optional<T>(key: string, value: T | null | undefined): Record<string, T> {
    return value === null || value === undefined ? {} : { [key]: value };
}

export function stripNetatmo(weather: Weather): Weather | null {
    const parsed = YrCurrentSchema.safeParse((weather.yr as { current?: unknown }).current);
    if (!parsed.success) return null;
    const yr = parsed.data;

    const conditions = weather.current.conditions;

    return {
        ...weather,
        netatmo: null,
        current: {
            // `mixed` is what the real offline capture carries: the
            // document is still a mixture of sources (forecast, sun, moon)
            // even when every `current` reading is Yr's.
            source: weather.current.source,
            timestamp: weather.current.timestamp,
            // No `min`/`max`/`trend`: those are derived from the station's
            // own history, which is precisely what is being withheld.
            temperature: { value: yr.temperature, source: 'yr' },
            humidity: { value: yr.humidity, source: 'yr' },
            pressure: { value: yr.pressure, source: 'yr' },
            wind: {
                speed: yr.wind_speed * MS_TO_KMH,
                direction: yr.wind_direction,
                ...optional('gust', yr.wind_gust === null || yr.wind_gust === undefined ? undefined : yr.wind_gust * MS_TO_KMH),
                // No `gust_direction`: Yr does not report one, and the
                // offline capture has no such key.
                source: 'yr',
            },
            // Everything under `rain` comes from the Netatmo rain gauge.
            rain: { source: 'yr' },
            conditions: {
                symbol_code: yr.symbol_code,
                ...optional('symbol_url', conditions.symbol_url),
                ...optional('cloud_coverage', yr.cloud_coverage),
                ...optional('uv_index', yr.uv_index),
                ...optional('dew_point', yr.dew_point),
                ...optional('fog', yr.fog),
                source: 'yr',
            },
        },
    };
}
