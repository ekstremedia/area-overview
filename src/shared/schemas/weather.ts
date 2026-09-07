import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

export const WeatherLocationSchema = z.object({
    name: z.string(),
    latitude: z.number(),
    longitude: z.number(),
});

const MeasurementSchema = z.object({
    value: z.number(),
    source: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    trend: z.string().optional(),
});

const WindSchema = z.object({
    speed: z.number(),
    direction: z.number(),
    gust: z.number().optional(),
    gust_direction: z.number().optional(),
    source: z.string().optional(),
});

// `current`/`last_hour`/`last_24h` come from the Netatmo rain gauge module
// specifically: when Netatmo is offline/unreachable, upstream omits them
// entirely (observed: `undefined`, not `null`) while the rest of `current`
// stays populated from Yr/MET.no. `.nullable()` is added defensively in
// case upstream ever sends `null` instead of omitting the key.
const RainSchema = z.object({
    current: z.number().nullable().optional(),
    last_hour: z.number().nullable().optional(),
    last_24h: z.number().nullable().optional(),
    source: z.string().optional(),
});

const ConditionsSchema = z.object({
    symbol_code: z.string(),
    symbol_url: z.string().optional(),
    cloud_coverage: z.number().optional(),
    uv_index: z.number().optional(),
    dew_point: z.number().optional(),
    fog: z.number().optional(),
    source: z.string().optional(),
});

export const WeatherCurrentSchema = z.object({
    source: z.string(),
    timestamp: IsoTimestampSchema,
    temperature: MeasurementSchema,
    humidity: MeasurementSchema,
    pressure: MeasurementSchema,
    wind: WindSchema,
    rain: RainSchema,
    conditions: ConditionsSchema,
});

const HourlyForecastEntrySchema = z.object({
    time: IsoTimestampSchema,
    temperature: z.number(),
    symbol_code: z.string(),
    symbol_url: z.string().optional(),
    precipitation: z.number().optional(),
    wind_speed: z.number().optional(),
    wind_direction: z.number().optional(),
    cloud_coverage: z.number().optional(),
    fog: z.number().optional(),
});

// A single part-of-day slice of a daily entry's `periods` object (night/
// morning/afternoon/evening), each with its own icon -- what lets a daily
// row show the four small period icons the way Yr's own UI does. All three
// fields are `.nullable()`, not just `.optional()`: a real live response
// (`GET /api/weather` against nesthus.no, checked while building this)
// sends `symbol_code`/`symbol_url`/`precipitation` as `null` -- not
// omitted -- for far-future days/periods the upstream forecast model has
// less confidence in, matching the same defensive convention as
// `DailyForecastEntrySchema`'s own top-level fields below.
const DailyForecastPeriodSchema = z.object({
    symbol_code: z.string().nullable().optional(),
    symbol_url: z.string().nullable().optional(),
    precipitation: z.number().nullable().optional(),
});

const DailyForecastPeriodsSchema = z.object({
    night: DailyForecastPeriodSchema,
    morning: DailyForecastPeriodSchema,
    afternoon: DailyForecastPeriodSchema,
    evening: DailyForecastPeriodSchema,
});

// Daily forecast entries carry a large, upstream-specific nested shape
// (`steps`, ...) that this app does not consume field-by-field and does
// not validate; only the top-level summary fields plus `periods` (used by
// the daily forecast section's part-of-day icons) are validated,
// everything else passes through untouched. `periods` is `.optional()`,
// not required: `weather-netatmo-offline.json`'s fixture daily entries
// (a real captured degraded-upstream response) omit it entirely.
const DailyForecastEntrySchema = z.object({
    date: z.string(),
    temperature_min: z.number().nullable().optional(),
    temperature_max: z.number().nullable().optional(),
    symbol_code: z.string().nullable().optional(),
    symbol_url: z.string().nullable().optional(),
    periods: DailyForecastPeriodsSchema.optional(),
});

export const WeatherForecastSchema = z.object({
    hourly: z.array(HourlyForecastEntrySchema),
    daily: z.array(DailyForecastEntrySchema),
});

/** A single day of `forecast.daily`, exported for `WeatherPage.ts`'s daily forecast section. */
export type DailyForecastEntry = z.infer<typeof DailyForecastEntrySchema>;

export const WeatherAttributionSchema = z.object({
    yr: z.object({ text: z.string(), url: z.string(), license: z.string().optional() }),
    netatmo: z.object({ text: z.string(), url: z.string() }),
});

/**
 * `sun`, `moon`, `netatmo` and `yr`/`nowcast` carry deep, upstream-specific
 * shapes (per-module Netatmo device data, sunrise/sunset/moon-phase
 * breakdowns, MET Norway timeseries) that this app does not need to
 * validate field-by-field to prove the contract for this phase. They are
 * required to be present, but their internals are treated as unknown so a
 * shape change upstream doesn't break parsing of the fields this app does
 * consume.
 */
export const WeatherSchema = z.object({
    location: WeatherLocationSchema,
    current: WeatherCurrentSchema,
    forecast: WeatherForecastSchema,
    historical: z.unknown().nullable(),
    sun: z.record(z.string(), z.unknown()),
    moon: z.record(z.string(), z.unknown()),
    // `null` when Terje's home Netatmo weather station is offline/
    // unreachable -- a real, expected degraded-but-valid state, not
    // malformed data.
    netatmo: z.record(z.string(), z.unknown()).nullable(),
    yr: z.record(z.string(), z.unknown()),
    nowcast: z.record(z.string(), z.unknown()),
    attribution: WeatherAttributionSchema,
    cachedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
});

export type Weather = z.infer<typeof WeatherSchema>;

/**
 * `GET /api/weather/summary` returns a populated summary when the model has
 * generated one, but can also answer HTTP 204 with `{ "summary": null }`
 * before the first summary exists -- that is a valid, non-error state, not
 * a shape to reject.
 */
export const WeatherSummarySchema = z.object({
    summary_no: z.string(),
    summary_en: z.string(),
    model: z.string(),
    generated_at: IsoTimestampSchema,
    location: z.object({
        name: z.string(),
        lat: z.number(),
        lon: z.number(),
    }),
    age_minutes: z.number(),
    eval_count: z.number(),
    duration_ms: z.number(),
    translation_duration_ms: z.number(),
});

export type WeatherSummary = z.infer<typeof WeatherSummarySchema>;

export const EmptyWeatherSummarySchema = z.object({
    summary: z.null(),
});

export const WeatherSummaryResponseSchema = z.union([WeatherSummarySchema, EmptyWeatherSummarySchema]);

export type WeatherSummaryResponse = z.infer<typeof WeatherSummaryResponseSchema>;
