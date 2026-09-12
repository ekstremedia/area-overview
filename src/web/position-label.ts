/**
 * What to call the place a page is showing.
 *
 * The upstream names a custom position `"Custom Location"` -- an internal
 * sentinel, in English, that must never reach a Norwegian kiosk. Tide
 * returns real station names (`"Oslo"`), and for a position outside
 * Norway it returns `"Sortland"` with a null station code, which is worse
 * than useless: it names somewhere the data is not about.
 *
 * So a name is used only when it is a real one, and formatted coordinates
 * stand in otherwise. Coordinates are already rounded to ~1km, so showing
 * them reveals nothing the request did not already carry.
 */

/** The upstream's own sentinel for "you gave me coordinates rather than my configured location". */
const CUSTOM_LOCATION_SENTINEL = 'Custom Location';

export interface PositionLabelOptions {
    /** The `location.name` the payload carried, if any. */
    name?: string | undefined;
    /** The position asked about, or `null` for the home position. */
    point: { lat: number; lng: number } | null;
    /** Formats one coordinate for display -- `formatNumber` from i18n, so decimal separators follow the language. */
    formatCoordinate: (value: number) => string;
}

export function positionLabel(options: PositionLabelOptions): string {
    const trimmed = options.name?.trim() ?? '';
    const usable = trimmed !== '' && trimmed !== CUSTOM_LOCATION_SENTINEL;
    if (usable) return trimmed;

    const point = options.point;
    if (!point) return '';
    return `${options.formatCoordinate(point.lat)}, ${options.formatCoordinate(point.lng)}`;
}
