/**
 * Turns an AIS ship-type code into something a person can read.
 *
 * BarentsWatch passes the raw ITU-R M.1371 code straight through, so a
 * popup used to say "Type 75" -- true, and useless. The codes are
 * organised in tens: the first digit is the category (7x cargo, 8x
 * tanker, 6x passenger...), and for those ranges the second digit is only
 * the IMO hazard class of the cargo (X/Y/Z/OS), which is not something a
 * window-watcher needs. So 70-79 all collapse to "Lasteskip", and only
 * the 30-59 band -- where each code is genuinely a different kind of
 * vessel -- is mapped one by one.
 *
 * Unknown and reserved codes fall back to the bare number rather than a
 * wrong guess: "Type 19" is at least honest.
 */
import type { ParamlessKey } from '../../i18n/index.js';

/** Codes 30-59, where each value means a distinct kind of vessel. */
const EXACT_CODES: Record<number, ParamlessKey> = {
    30: 'shipType.fishing',
    31: 'shipType.towing',
    32: 'shipType.towing',
    33: 'shipType.dredging',
    34: 'shipType.diving',
    35: 'shipType.military',
    36: 'shipType.sailing',
    37: 'shipType.pleasure',
    50: 'shipType.pilot',
    51: 'shipType.searchAndRescue',
    52: 'shipType.tug',
    53: 'shipType.portTender',
    54: 'shipType.antiPollution',
    55: 'shipType.lawEnforcement',
    58: 'shipType.medical',
};

/** The bands whose second digit is only a cargo-hazard class, so the whole ten reads the same. */
const BANDS: { from: number; to: number; key: ParamlessKey }[] = [
    { from: 20, to: 29, key: 'shipType.wingInGround' },
    { from: 40, to: 49, key: 'shipType.highSpeed' },
    { from: 60, to: 69, key: 'shipType.passenger' },
    { from: 70, to: 79, key: 'shipType.cargo' },
    { from: 80, to: 89, key: 'shipType.tanker' },
    { from: 90, to: 99, key: 'shipType.other' },
];

/**
 * The translation key describing `shipType`, or `null` when the code is
 * absent, unparseable, or one this table has no honest name for -- the
 * caller then falls back to showing the raw code.
 *
 * `0` is "not available" in the spec and is extremely common in the live
 * feed (a transponder that simply never had its type configured), so it
 * gets the same "unknown" treatment as a missing field rather than being
 * rendered as "Type 0".
 */
export function shipTypeKey(shipType: string | null): ParamlessKey | null {
    if (shipType === null) return null;
    const code = Number(shipType.trim());
    if (!Number.isInteger(code) || code <= 0 || code > 99) return null;

    const exact = EXACT_CODES[code];
    if (exact) return exact;

    for (const band of BANDS) {
        if (code >= band.from && code <= band.to) return band.key;
    }
    return null; // 1-19 and 38/39/56/57/59 are reserved or local-use: no honest name
}
