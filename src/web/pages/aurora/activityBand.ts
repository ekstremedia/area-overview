/**
 * Kp / hemispheric-power -> activity-band word ("quiet" / "active" /
 * "storm"), shown beside the raw Kp figure on the aurora page (artboard
 * 03). This is a hemispheric-power-based band, not a Kp-number band, even
 * though the artboard shows both side by side -- the thresholds below
 * match the original Laravel app's `config/aurora.php` ("quiet, active
 * 20-50 GW, storm > 50 GW hemispheric power"), so they must not be
 * changed without updating that reference too.
 */
export type ActivityBand = 'quiet' | 'active' | 'storm';

/** Below this, and above `STORM_THRESHOLD_GW`, the band is "quiet"/"storm" respectively; between the two it's "active". */
export const ACTIVE_THRESHOLD_GW = 20;
export const STORM_THRESHOLD_GW = 50;

export function activityBandForHemisphericPower(hemisphericPowerGw: number): ActivityBand {
    if (hemisphericPowerGw > STORM_THRESHOLD_GW) return 'storm';
    if (hemisphericPowerGw >= ACTIVE_THRESHOLD_GW) return 'active';
    return 'quiet';
}
