import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

export const TideLocationSchema = z.object({
    name: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    code: z.string(),
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
    nextHighTide: TideNextExtremeSchema,
    nextLowTide: TideNextExtremeSchema,
    currentLevel: TideCurrentLevelSchema,
    observedDeviation: TideObservedDeviationSchema.optional(),
    ocean: TideOceanSchema.optional(),
    attribution: z.string(),
    attributionUrl: z.string(),
    cachedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    serverNow: IsoTimestampSchema,
    windowStart: IsoTimestampSchema,
    windowEnd: IsoTimestampSchema,
});

export type Tide = z.infer<typeof TideSchema>;
