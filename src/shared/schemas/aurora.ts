import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

const KpPointSchema = z.object({
    time: IsoTimestampSchema,
    kp: z.number(),
});

// `kpCurrent` uses `value` where `kpForecast`/`kpHistory` use `kp` for the
// same underlying Kp index -- two distinct upstream shapes, not a typo.
const KpCurrentSchema = z.object({
    time: IsoTimestampSchema,
    value: z.number(),
});

/**
 * `status`, `solarWind`, `indices` and `alerts` sub-objects. NOAA's own
 * shapes are attached per-block. `attribution`/`attributionUrl` are
 * required (not optional) because the design requires them to always be
 * displayed alongside any NOAA-sourced data.
 */
export const AuroraStatusSchema = z.object({
    kpCurrent: KpCurrentSchema,
    kpForecast: z.array(KpPointSchema.extend({ noaaScale: z.string().nullable().optional() })),
    scales: z.record(z.string(), z.unknown()),
    hemisphericPower: z.record(z.string(), z.unknown()),
    attribution: z.string(),
    attributionUrl: z.string(),
    cachedAt: IsoTimestampSchema,
});

export type AuroraStatus = z.infer<typeof AuroraStatusSchema>;

export const AuroraOvalSchema = z.object({
    grid: z.object({
        updatedAt: IsoTimestampSchema,
        maxProbabilityZones: z.array(z.unknown()),
    }),
    images: z.object({
        northUrl: z.string(),
        southUrl: z.string(),
    }),
    attribution: z.string(),
    attributionUrl: z.string(),
    cachedAt: IsoTimestampSchema,
});

export type AuroraOval = z.infer<typeof AuroraOvalSchema>;

const AuroraSolarWindSchema = z.object({
    mag: z.record(z.string(), z.unknown()),
    plasma: z.record(z.string(), z.unknown()),
    current: z.record(z.string(), z.unknown()),
    conditions: z.record(z.string(), z.unknown()),
    attribution: z.string(),
    attributionUrl: z.string(),
    cachedAt: IsoTimestampSchema,
});

const AuroraIndicesSchema = z.object({
    kpHistory: z.array(KpPointSchema),
    kpForecast: z.array(z.record(z.string(), z.unknown())),
    dst: z.array(z.record(z.string(), z.unknown())),
    attribution: z.string(),
    attributionUrl: z.string(),
    cachedAt: IsoTimestampSchema,
});

const AuroraAlertsSchema = z.object({
    alerts: z.array(z.record(z.string(), z.unknown())),
    attribution: z.string(),
    attributionUrl: z.string(),
    cachedAt: IsoTimestampSchema,
});

/**
 * `GET /api/aurora/all` -- the combined response every block of which
 * carries its own `attribution`/`attributionUrl`, plus a top-level pair
 * for the response as a whole.
 */
export const AuroraAllSchema = z.object({
    status: AuroraStatusSchema,
    oval: AuroraOvalSchema,
    solarWind: AuroraSolarWindSchema,
    indices: AuroraIndicesSchema,
    alerts: AuroraAlertsSchema,
    attribution: z.string(),
    attributionUrl: z.string(),
});

export type AuroraAll = z.infer<typeof AuroraAllSchema>;
