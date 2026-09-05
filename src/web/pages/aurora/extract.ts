/**
 * Careful, runtime-checked extraction from the loosely-typed
 * (`z.record(z.string(), z.unknown())`) blocks of `AuroraAll` --
 * `hemisphericPower`, `status.scales`, `solarWind.current` and
 * `alerts.alerts` are all modelled that way in `shared/schemas/aurora.ts`
 * because NOAA's own shapes for them weren't fully typed in Phase 1. Every
 * function here `safeParse`s the specific fields this page actually needs
 * and returns `null` on a shape mismatch, rather than an unchecked cast
 * that could throw or silently read `undefined` deep into a render.
 */
import { z } from 'zod';

const HemisphericPowerSchema = z.object({
    north: z.object({ valueGw: z.number() }),
});

/** The northern-hemisphere reading -- this app's location (Sortland) is in the northern hemisphere, matching the OVATION north image already shown alongside it. */
export function hemisphericPowerNorthGw(hemisphericPower: Record<string, unknown>): number | null {
    const parsed = HemisphericPowerSchema.safeParse(hemisphericPower);
    return parsed.success ? parsed.data.north.valueGw : null;
}

const ScalesSchema = z.object({
    G: z.object({ level: z.string() }),
});

/** NOAA's G-scale geomagnetic storm level (e.g. "G1"), for the alert band's caption. */
export function scaleGLevel(scales: Record<string, unknown>): string | null {
    const parsed = ScalesSchema.safeParse(scales);
    return parsed.success ? parsed.data.G.level : null;
}

const SolarWindCurrentSchema = z.object({
    bz: z.number(),
    speed: z.number(),
    density: z.number(),
});

export interface SolarWindStats {
    bz: number;
    speed: number;
    density: number;
}

export function solarWindStats(current: Record<string, unknown>): SolarWindStats | null {
    const parsed = SolarWindCurrentSchema.safeParse(current);
    return parsed.success ? parsed.data : null;
}

const AlertSchema = z.object({
    summary: z.string(),
});

/** The most recent alert's one-line summary, or `null` when the list is empty (nothing to show in the alert band) or the first entry's shape is unexpected. */
export function firstAlertSummary(alerts: readonly Record<string, unknown>[]): string | null {
    const first = alerts[0];
    if (first === undefined) return null;
    const parsed = AlertSchema.safeParse(first);
    return parsed.success ? parsed.data.summary : null;
}
