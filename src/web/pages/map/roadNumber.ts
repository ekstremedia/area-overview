/**
 * Statens vegvesen writes a road number as a single letter and a number
 * run together -- `E10`, `R85`, `F82`, `F7542`, `K1234` -- which is the
 * database form, not the form anyone reads on a sign or says out loud.
 * Norwegian usage is "E10", "Rv. 85", "Fv. 7542", "Kv. 1234": the
 * European routes keep their bare letter, everything else takes the
 * abbreviated road-class prefix and a space.
 *
 * Kept as its own module (rather than a helper inside `roads.ts`)
 * because it is pure string work with no Leaflet, no DOM and no i18n --
 * the abbreviations are Norwegian road classes, identical in the English
 * UI, the same way `E10` is.
 */

/**
 * The road-class letters upstream actually emits, mapped to their
 * everyday abbreviation. `E` is absent deliberately: an Europaveg is
 * written `E10`, never "Ev. 10".
 */
const ROAD_CLASS_PREFIXES: Readonly<Record<string, string>> = {
    R: 'Rv.',
    F: 'Fv.',
    K: 'Kv.',
    /** Private roads appear in the data set's own documentation but were not seen in a live viewport; handled here rather than falling through to the raw form. */
    P: 'Pv.',
};

/**
 * `"F7542"` -> `"Fv. 7542"`, `"E10"` -> `"E10"`, `null` -> `null`.
 *
 * A value that does not look like a road number at all is passed
 * through trimmed rather than dropped or decorated: `ROAD_NUMBER` is a
 * free-text upstream field (six of 2665 records carry none at all), and
 * showing what upstream said is more useful than hiding it because this
 * function did not recognise the shape. Blank counts as absent.
 */
export function formatRoadNumber(roadNumber: string | null): string | null {
    if (roadNumber === null) return null;
    const trimmed = roadNumber.trim();
    if (trimmed === '') return null;

    const match = /^([A-Za-z])\s*(\d.*)$/.exec(trimmed);
    if (!match) return trimmed;

    const [, letter = '', rest = ''] = match;
    const prefix = ROAD_CLASS_PREFIXES[letter.toUpperCase()];
    if (prefix === undefined) return `${letter.toUpperCase()}${rest}`;
    return `${prefix} ${rest}`;
}
