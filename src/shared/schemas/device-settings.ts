import { z } from 'zod';

/**
 * Per-device settings, persisted in `localStorage` on the kiosk device
 * itself -- never sent to or stored by the server (unlike `Settings`).
 */
export const DeviceSettingsSchema = z.object({
    theme: z.enum(['dark', 'light', 'system']).default('dark'),
    fontScale: z.number().min(0.8).max(1.6).default(1),
    /**
     * Which basemap the map page draws under everything else. `auto` (the
     * default) follows `theme` and the night schedule exactly as before
     * this setting existed -- dark chrome, dark tiles. Any other value is
     * a deliberate choice made from the map's own basemap button and wins
     * over both, including at night: someone who switched to satellite
     * asked for satellite, and having the tiles flip back under them at
     * sunset would read as a bug rather than as a policy.
     *
     * Device-local like `theme` and `fontScale`: the kiosk's own look, not
     * a shared configuration decision.
     */
    basemap: z.enum(['auto', 'dark', 'light', 'satellite']).default('auto'),
});

export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>;
