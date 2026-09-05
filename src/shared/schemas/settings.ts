import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

/**
 * A camera placement -- where a camera's marker sits on the map. Same
 * range checks as `LatLngSchema`, kept separate so placements can evolve
 * independently of the generic lat/lng shape.
 */
export const PlacementSchema = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
});

export type Placement = z.infer<typeof PlacementSchema>;

const HomeViewSchema = z.object({
    lat: z.number().min(-90).max(90).default(68.6984),
    lng: z.number().min(-180).max(180).default(15.4129),
    zoom: z.number().min(1).max(19).default(11),
});

const PageIdSchema = z.enum(['map', 'weather', 'aurora', 'tide', 'cameras']);

const NightModeSchema = z.object({
    enabled: z.boolean().default(false),
    from: z.string().default('23:00'),
    to: z.string().default('06:00'),
    mode: z.enum(['dark', 'dim', 'off']).default('dim'),
});

const ShipsSettingsSchema = z.object({
    enabled: z.boolean().default(true),
    pollSeconds: z.number().min(10).max(120).default(15),
    maxAgeMinutes: z.number().min(1).max(120).default(30),
});

const AircraftSettingsSchema = z.object({
    enabled: z.boolean().default(true),
    pollSeconds: z.number().min(5).max(120).default(10),
    maxAgeMinutes: z.number().min(1).max(60).default(10),
    showOnGround: z.boolean().default(false),
});

/**
 * The shared, server-persisted settings. Every key has a `.default()`, so
 * `SettingsSchema.parse({})` yields a fully populated `Settings` object --
 * every default lives here, nowhere else.
 */
export const SettingsSchema = z.object({
    language: z.enum(['nb', 'en']).default('nb'),
    homeView: HomeViewSchema.default({ lat: 68.6984, lng: 15.4129, zoom: 11 }),
    placements: z.record(z.string(), PlacementSchema).default({}),
    pollIntervalSeconds: z.number().min(10).max(600).default(30),
    enabledPages: z.array(PageIdSchema).default(['map', 'weather', 'aurora', 'tide', 'cameras']),
    idleResetSeconds: z.number().min(0).max(3600).default(300),
    night: NightModeSchema.default({ enabled: false, from: '23:00', to: '06:00', mode: 'dim' }),
    brightness: z.number().min(20).max(100).default(100),
    ships: ShipsSettingsSchema.default({ enabled: true, pollSeconds: 15, maxAgeMinutes: 30 }),
    aircraft: AircraftSettingsSchema.default({ enabled: true, pollSeconds: 10, maxAgeMinutes: 10, showOnGround: false }),
    updatedAt: IsoTimestampSchema.default(() => new Date().toISOString()),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * A partial patch to settings. Excludes `placements` (which get their own
 * per-camera routes in a later phase) and `updatedAt` (server-set on every
 * write).
 */
export const SettingsPatchSchema = SettingsSchema.omit({ placements: true, updatedAt: true }).partial();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
