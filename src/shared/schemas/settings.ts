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

/**
 * Undecorated per-field bases for `homeView`'s three numbers -- same
 * "no `.default()`" reasoning as `patchableFieldSchemas` further down
 * this file (see its doc comment): exported so the settings page's
 * `NumberField`s can validate lat/lng/zoom against the real constraint
 * each one carries in `SettingsSchema`, without a parallel hand-written
 * validator and without a `.default()`-wrapped schema whose `ZodDefault`
 * type doesn't line up with a plain `ZodType<number>` parameter.
 */
export const HomeViewNumberSchema = {
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    zoom: z.number().min(1).max(19),
};

const HomeViewSchema = z.object({
    lat: HomeViewNumberSchema.lat.default(68.6984),
    lng: HomeViewNumberSchema.lng.default(15.4129),
    zoom: HomeViewNumberSchema.zoom.default(11),
});

const PageIdSchema = z.enum(['map', 'weather', 'aurora', 'tide', 'cameras']);

/** One of the five toggleable main-nav pages -- `enabledPages`' element type. Excludes `settings`, which is never toggleable (see `SettingsSchema.enabledPages`'s doc comment on this file). */
export type PageId = z.infer<typeof PageIdSchema>;

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
 * Auto-cycle: kiosk slideshow mode -- rotates through pages on a timer
 * with a swipe transition (`web/shell/autoCycle.ts` owns the pure "what's
 * next" logic and its timer; `web/shell/AppShell.ts` owns the transition
 * itself).
 *
 * `pages` uses the empty array as the "cycle every currently-*enabled*
 * page" sentinel, rather than a separate `allPages: boolean` flag: it
 * composes for free with `enabledPages` (there's only ever the one array
 * to consult, no second flag that can drift out of sync with it) and
 * matches this schema's existing "empty means default" shape for
 * collection-typed settings elsewhere in the app.
 *
 * A page can be listed here and later toggled off via `enabledPages` --
 * that's allowed, and deliberately not reconciled at write time: the
 * page simply stays in `autoCycle.pages` but is skipped whenever its turn
 * comes up. `nextCycleRoute` intersects `autoCycle.pages` (or, if empty,
 * `enabledPages` itself) with `enabledPages` fresh on every call, so
 * re-enabling the page later resumes cycling it with no need to re-pick
 * it in the settings UI.
 */
const AutoCycleSchema = z.object({
    enabled: z.boolean().default(false),
    intervalSeconds: z.number().min(30).max(3600).default(180), // 3 minutes
    pages: z.array(PageIdSchema).default([]), // empty = cycle every currently-enabled page; non-empty = cycle only these
});

/**
 * The ten top-level fields a `PATCH` can touch, as *undecorated* schemas
 * -- deliberately without their own `.default(...)`. `SettingsSchema`
 * below applies `.default(...)` to each of these when building the full
 * settings object (so `SettingsSchema.parse({})` is still fully
 * populated); `SettingsPatchSchema` further down uses these same bases
 * directly, wrapped only in a plain `.optional()`.
 *
 * This split exists because of a real Zod v4 interaction, not style
 * preference: wrapping an already-`.default(...)`-decorated schema in
 * `.optional()` -- which is exactly what `SomeSchema.partial()` does to
 * every field -- does NOT make an absent key parse to `undefined`. The
 * inner `.default(...)` still fires first (the composed shape is
 * `optional(default(base))`, and `.optional()` here doesn't intercept
 * `undefined` before `.default()` gets to substitute its value), so
 * `.partial()` on a schema whose fields already carry defaults silently
 * *backfills* every field the caller didn't mention with its default,
 * instead of omitting it. A previous version of this schema built
 * `SettingsPatchSchema` as `SettingsSchema.omit(...).partial()` and hit
 * exactly this: `SettingsPatchSchema.parse({ brightness: 60 })` came
 * back with all nine fields populated, not just `brightness` -- silently
 * turning every partial `PATCH` into a full overwrite back to defaults
 * for every field the caller didn't mention. Verify this doesn't
 * regress by checking that `SettingsPatchSchema.parse({ brightness: 60
 * })` has exactly one key.
 */
/**
 * Camera ids the viewer has switched off -- hidden from the cameras page,
 * from the map, and from the camera count.
 *
 * A deny-list rather than an allow-list, deliberately: the camera roster
 * comes from upstream at runtime (`/api/cameras`), so an allow-list would
 * silently hide any camera added later until someone noticed and enabled
 * it. An id that no longer exists upstream simply never matches anything
 * and is harmless, so entries are not pruned.
 */
const DisabledCamerasSchema = z.array(z.string());

/**
 * Weather data sources.
 *
 * An object rather than a bare `weather.useNetatmo` boolean, matching
 * `ships`/`aircraft`, so a later weather preference needs no new
 * top-level settings key.
 *
 * Deliberately NOT device-overridable (see `SettingsOverrideSchema`): the
 * server enforces this gate, so a local override would be a control that
 * visibly does nothing.
 */
const WeatherSettingsSchema = z.object({
    /** When false, `/api/weather` serves Yr-only readings to every device, logged in or not. */
    useNetatmo: z.boolean().default(true),
});

export const patchableFieldSchemas = {
    language: z.enum(['nb', 'en']),
    homeView: HomeViewSchema,
    pollIntervalSeconds: z.number().min(10).max(600),
    enabledPages: z.array(PageIdSchema),
    idleResetSeconds: z.number().min(0).max(3600),
    night: NightModeSchema,
    brightness: z.number().min(20).max(100),
    ships: ShipsSettingsSchema,
    aircraft: AircraftSettingsSchema,
    autoCycle: AutoCycleSchema,
    disabledCameras: DisabledCamerasSchema,
    weather: WeatherSettingsSchema,
};

/**
 * The shared, server-persisted settings. Every key has a `.default()`, so
 * `SettingsSchema.parse({})` yields a fully populated `Settings` object --
 * every default lives here, nowhere else.
 */
export const SettingsSchema = z.object({
    language: patchableFieldSchemas.language.default('nb'),
    homeView: patchableFieldSchemas.homeView.default({ lat: 68.6984, lng: 15.4129, zoom: 11 }),
    placements: z.record(z.string(), PlacementSchema).default({}),
    pollIntervalSeconds: patchableFieldSchemas.pollIntervalSeconds.default(30),
    enabledPages: patchableFieldSchemas.enabledPages.default(['map', 'weather', 'aurora', 'tide', 'cameras']),
    idleResetSeconds: patchableFieldSchemas.idleResetSeconds.default(300),
    night: patchableFieldSchemas.night.default({ enabled: false, from: '23:00', to: '06:00', mode: 'dim' }),
    brightness: patchableFieldSchemas.brightness.default(100),
    ships: patchableFieldSchemas.ships.default({ enabled: true, pollSeconds: 15, maxAgeMinutes: 30 }),
    aircraft: patchableFieldSchemas.aircraft.default({ enabled: true, pollSeconds: 10, maxAgeMinutes: 10, showOnGround: false }),
    autoCycle: patchableFieldSchemas.autoCycle.default({ enabled: false, intervalSeconds: 180, pages: [] }),
    disabledCameras: patchableFieldSchemas.disabledCameras.default([]),
    weather: patchableFieldSchemas.weather.default({ useNetatmo: true }),
    updatedAt: IsoTimestampSchema.default(() => new Date().toISOString()),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * A partial patch to settings. Excludes `placements` (which get their own
 * per-camera routes) and `updatedAt` (server-set on every write). Built
 * from `patchableFieldSchemas`' undecorated bases -- see the comment
 * above them -- so a key the caller omits parses to `undefined` and is
 * genuinely absent from the result, not silently replaced by its default.
 */
export const SettingsPatchSchema = z.object({
    language: patchableFieldSchemas.language.optional(),
    homeView: patchableFieldSchemas.homeView.optional(),
    pollIntervalSeconds: patchableFieldSchemas.pollIntervalSeconds.optional(),
    enabledPages: patchableFieldSchemas.enabledPages.optional(),
    idleResetSeconds: patchableFieldSchemas.idleResetSeconds.optional(),
    night: patchableFieldSchemas.night.optional(),
    brightness: patchableFieldSchemas.brightness.optional(),
    ships: patchableFieldSchemas.ships.optional(),
    aircraft: patchableFieldSchemas.aircraft.optional(),
    autoCycle: patchableFieldSchemas.autoCycle.optional(),
    disabledCameras: patchableFieldSchemas.disabledCameras.optional(),
    weather: patchableFieldSchemas.weather.optional(),
});

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/**
 * A device's own overrides, laid over the shared server settings for that
 * browser alone (`src/web/settings/localOverrides.ts`).
 *
 * This exists because the app is public now. The shared settings are one
 * JSON file that every visitor reads and a logged-in device writes; a
 * stranger in Oslo who wants the map centred on Oslo, or the page in
 * English, must not have to move Terje's kiosk to get it. So when nobody
 * is logged in, an edit lands here instead of in a `PATCH`.
 *
 * Built from the same undecorated `patchableFieldSchemas` bases wrapped in
 * a bare `.optional()`, for the same reason `SettingsPatchSchema` is --
 * see the long comment above those bases on why `.partial()` silently
 * backfills defaults. It is deliberately NOT an alias of
 * `SettingsPatchSchema`: the two are allowed to diverge, and already do.
 *
 * What is missing, and why:
 *
 * - `placements` -- where a camera sits on the map is shared content
 *   rather than a viewer preference, and stays password-only.
 * - `updatedAt` -- server-set on every write.
 *
 * Anything a visitor can sensibly want differently on their own screen is
 * here, including the kiosk-operations fields: the schema minimums bound
 * the poll intervals, and the server's own caches and outbound gates make
 * upstream cost independent of what any one client asks for.
 */
export const SettingsOverrideSchema = z.object({
    language: patchableFieldSchemas.language.optional(),
    homeView: patchableFieldSchemas.homeView.optional(),
    pollIntervalSeconds: patchableFieldSchemas.pollIntervalSeconds.optional(),
    enabledPages: patchableFieldSchemas.enabledPages.optional(),
    idleResetSeconds: patchableFieldSchemas.idleResetSeconds.optional(),
    night: patchableFieldSchemas.night.optional(),
    brightness: patchableFieldSchemas.brightness.optional(),
    ships: patchableFieldSchemas.ships.optional(),
    aircraft: patchableFieldSchemas.aircraft.optional(),
    autoCycle: patchableFieldSchemas.autoCycle.optional(),
    disabledCameras: patchableFieldSchemas.disabledCameras.optional(),
});

export type SettingsOverride = z.infer<typeof SettingsOverrideSchema>;

/** The fields a device may override, for iterating without hand-maintaining a second list that can drift from the schema. */
export const OVERRIDABLE_FIELDS = Object.keys(SettingsOverrideSchema.shape) as (keyof SettingsOverride)[];
