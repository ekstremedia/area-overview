import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

/**
 * `code` is `null` when there is no Kartverket station for the requested
 * position at all -- which is what a position outside Norway produces.
 * Verified against the live upstream: Madrid coordinates come back HTTP
 * 200 with `code: null`, empty `timeseries`/`extremes`, and -- misleadingly
 * -- `name: "Sortland"`. So a null `code` is the reliable signal that
 * there is nothing to show, and `name` must not be trusted without it.
 */
export const TideLocationSchema = z.object({
    name: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    code: z.string().nullable(),
});

export const TideTimeseriesEntrySchema = z.object({
    time: IsoTimestampSchema,
    value: z.number(),
    type: z.string(),
    observation: z.number().nullable().optional(),
    forecast: z.number().nullable().optional(),
    level: z.number().nullable().optional(),
    weatherEffect: z.number().nullable().optional(),
});

export const TideExtremeSchema = z.object({
    time: IsoTimestampSchema,
    value: z.number(),
    type: z.string(),
});

/**
 * `timeFormatted`/`dateFormatted`/`relativeTime` are pre-formatted,
 * Norwegian-only prose strings upstream attaches to the next high/low
 * tide. They exist in the fixture, so they're modelled here, but they are
 * never displayed by this app -- the frontend computes its own localized
 * relative times with `Intl.RelativeTimeFormat` (later phase) instead.
 */
export const TideNextExtremeSchema = TideExtremeSchema.extend({
    timeFormatted: z.string().nullable().optional(),
    dateFormatted: z.string().nullable().optional(),
    relativeTime: z.string().nullable().optional(),
});

export const TideCurrentLevelSchema = z.object({
    time: IsoTimestampSchema,
    value: z.number(),
    trend: z.string(),
});

const OceanCurrentSchema = z.object({
    time: IsoTimestampSchema,
    sea_water_temperature: z.number().nullable().optional(),
    sea_surface_wave_height: z.number().nullable().optional(),
    sea_surface_wave_from_direction: z.number().nullable().optional(),
    sea_water_speed: z.number().nullable().optional(),
    sea_water_to_direction: z.number().nullable().optional(),
});

export const TideOceanSchema = z.object({
    current: OceanCurrentSchema,
    hourly: z.array(OceanCurrentSchema),
});

/**
 * How far the currently observed level departs from the astronomical
 * prediction (weather-driven surge/setdown). Added in Phase 8 for the
 * tide page's "↑ stiger, +6 cm over prediksjon" trend line -- Phase 1
 * deliberately left it unmodelled since nothing consumed it yet.
 */
export const TideObservedDeviationSchema = z.object({
    time: IsoTimestampSchema,
    value: z.number(),
});

/**
 * `GET /api/tide` -- only the fields a tide page will actually consume are
 * modelled here; upstream also sends `predictionExtremes`,
 * `forecastExtremes` and `nextExtremes`, which are left unmodelled and
 * simply stripped on parse. `ocean` is optional: not every station upstream
 * proxies has an ocean-forecast product behind it, so the tide page must
 * hide its sea-state stats entirely rather than show them as zero/empty
 * when it's absent.
 */
export const TideSchema = z.object({
    location: TideLocationSchema,
    timeseries: z.array(TideTimeseriesEntrySchema),
    extremes: z.array(TideExtremeSchema),
    // Null together with an empty `timeseries` when the requested position
    // has no tide station near it. A real, expected degraded-but-valid
    // state rather than malformed data -- the same lesson as
    // `weather.ts`'s Netatmo fields, where a stricter schema turned a
    // degraded upstream response into a full 502 in production.
    nextHighTide: TideNextExtremeSchema.nullable(),
    nextLowTide: TideNextExtremeSchema.nullable(),
    currentLevel: TideCurrentLevelSchema.nullable(),
    // `.nullable()` as well as `.optional()`: upstream sends these as
    // explicit `null` -- not absent -- for a position with no station.
    // Observed against the live API, and the same trap `weather.ts`
    // documents: `.optional()` alone rejects a `null` outright, turning a
    // valid degraded response into a 502.
    observedDeviation: TideObservedDeviationSchema.nullable().optional(),
    ocean: TideOceanSchema.nullable().optional(),
    attribution: z.string(),
    attributionUrl: z.string(),
    cachedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    serverNow: IsoTimestampSchema,
    windowStart: IsoTimestampSchema,
    windowEnd: IsoTimestampSchema,
});

export type Tide = z.infer<typeof TideSchema>;
