import { z } from 'zod';

/**
 * Per-device settings, persisted in `localStorage` on the kiosk device
 * itself -- never sent to or stored by the server (unlike `Settings`).
 */
export const DeviceSettingsSchema = z.object({
    theme: z.enum(['dark', 'light', 'system']).default('dark'),
    fontScale: z.number().min(0.8).max(1.6).default(1),
});

export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>;
