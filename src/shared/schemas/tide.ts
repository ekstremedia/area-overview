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
 * `GET /api/tide` -- only the fields a tide page will actually consume are
 * modelled here; upstream also sends `predictionExtremes`,
 * `forecastExtremes`, `nextExtremes` and `observedDeviation`, which are
 * left unmodelled and simply stripped on parse.
 */
export const TideSchema = z.object({
    location: TideLocationSchema,
    timeseries: z.array(TideTimeseriesEntrySchema),
    extremes: z.array(TideExtremeSchema),
    nextHighTide: TideNextExtremeSchema,
    nextLowTide: TideNextExtremeSchema,
    currentLevel: TideCurrentLevelSchema,
    ocean: TideOceanSchema,
    attribution: z.string(),
    attributionUrl: z.string(),
    cachedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    serverNow: IsoTimestampSchema,
    windowStart: IsoTimestampSchema,
    windowEnd: IsoTimestampSchema,
});

export type Tide = z.infer<typeof TideSchema>;
