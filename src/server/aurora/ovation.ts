/**
 * NOAA SWPC's OVATION aurora model, reduced to one number: the chance of
 * visible aurora at a given point right now.
 *
 * The upstream this app proxies for everything else cannot answer this --
 * `/api/aurora/all` ignores coordinates entirely and its
 * `maxProbabilityZones` array comes back empty -- so this is the one place
 * the BFF talks to a data source of its own.
 *
 * Three things shape the design, all of them consequences of the payload
 * being ~918 KB of JSON covering the entire globe:
 *
 * - **It never reaches a browser.** The grid is indexed here and the
 *   response carries a scalar. Shipping it would be a megabyte per
 *   visitor to answer a question worth two digits.
 * - **One fetch per process, not per visitor.** A single global slot,
 *   refreshed at most every `refreshMs` (NOAA republishes about every five
 *   minutes), gated on the last *attempt* rather than the last success so
 *   a failing NOAA is not retried by every request.
 * - **The parsed JSON is dropped immediately.** 65 160 three-element
 *   arrays become a `Uint8Array(360 * 180)` -- 64.8 KB resident, O(1)
 *   lookups -- and the array they came from is garbage.
 *
 * Nothing here is allowed to fail the aurora page. Every path returns
 * `null` rather than throwing: this is an enrichment on top of a response
 * that was already complete without it.
 */
import { z } from 'zod';

const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

/** NOAA republishes roughly every five minutes; asking more often returns the same grid. */
export const OVATION_REFRESH_MS = 5 * 60_000;

export const OVATION_ATTRIBUTION = 'NOAA SWPC (OVATION)';
export const OVATION_ATTRIBUTION_URL = 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast';

/**
 * `[longitude, latitude, probability]`, with longitude running 0..359
 * rather than -180..180 -- checked against the live endpoint, whose own
 * `Data Format` field says so in as many words.
 */
const OvationResponseSchema = z.object({
    'Observation Time': z.string(),
    'Forecast Time': z.string(),
    coordinates: z.array(z.tuple([z.number(), z.number(), z.number()])),
});

const LNG_STEPS = 360;
const LAT_STEPS = 180;

export interface OvationGrid {
    observationTime: string;
    forecastTime: string;
    /** Aurora probability (0-100) at the nearest grid cell. Longitude is normalised, so -10 and 350 agree. */
    probabilityAt(lat: number, lng: number): number;
}

/** Index into the flat grid. Latitude is offset by 90 so -90..89 maps to 0..179. */
function cellIndex(lat: number, lng: number): number {
    const normalisedLng = ((Math.round(lng) % LNG_STEPS) + LNG_STEPS) % LNG_STEPS;
    const clampedLat = Math.min(89, Math.max(-90, Math.round(lat)));
    return (clampedLat + 90) * LNG_STEPS + normalisedLng;
}

/**
 * Builds the lookup grid from a raw NOAA payload. Pure, so the indexing
 * can be tested against a captured fixture with no network at all.
 * Returns `null` for anything that doesn't parse.
 */
export function buildOvationGrid(raw: unknown): OvationGrid | null {
    const parsed = OvationResponseSchema.safeParse(raw);
    if (!parsed.success) return null;

    // A byte per cell: probabilities are whole percentages, so this is
    // lossless, and it is ~14x smaller than the array of arrays it
    // replaces.
    const cells = new Uint8Array(LNG_STEPS * LAT_STEPS);
    for (const [lng, lat, probability] of parsed.data.coordinates) {
        cells[cellIndex(lat, lng)] = Math.min(100, Math.max(0, Math.round(probability)));
    }

    return {
        observationTime: parsed.data['Observation Time'],
        forecastTime: parsed.data['Forecast Time'],
        probabilityAt(lat, lng) {
            return cells[cellIndex(lat, lng)] ?? 0;
        },
    };
}

export interface OvationClient {
    /** The current grid, or `null` when NOAA has never answered. Never throws; serves the previous grid while the gate is shut or a refresh fails. */
    gridFor(nowMs?: number): Promise<OvationGrid | null>;
}

export interface CreateOvationClientOptions {
    upstreamTimeoutMs: number;
    refreshMs?: number;
    fetchImpl?: typeof fetch;
}

/**
 * State lives in the returned closure rather than at module scope, so two
 * Fastify instances in one test run cannot share a grid and no test has to
 * reset module state it never created -- same reasoning as
 * `ships/snapshot.ts`.
 */
export function createOvationClient(options: CreateOvationClientOptions): OvationClient {
    const { upstreamTimeoutMs, fetchImpl } = options;
    const refreshMs = options.refreshMs ?? OVATION_REFRESH_MS;

    let grid: OvationGrid | null = null;
    let lastAttemptAt = Number.NEGATIVE_INFINITY;
    let inflight: Promise<OvationGrid | null> | undefined;

    async function refresh(): Promise<OvationGrid | null> {
        try {
            const response = await (fetchImpl ?? fetch)(OVATION_URL, {
                headers: { 'User-Agent': 'area-overview-bff/0.1' },
                signal: AbortSignal.timeout(upstreamTimeoutMs),
            });
            if (!response.ok) return grid;
            const body: unknown = await response.json();
            const next = buildOvationGrid(body);
            // A malformed payload leaves the previous grid in place rather
            // than blanking it: yesterday's probability beats none.
            if (next) grid = next;
            return grid;
        } catch {
            return grid;
        }
    }

    async function gridFor(nowMs: number = Date.now()): Promise<OvationGrid | null> {
        if (inflight) return inflight;
        if (nowMs - lastAttemptAt < refreshMs) return grid;

        // Stamped before the await, so a failing NOAA is retried once per
        // window rather than once per request.
        lastAttemptAt = nowMs;
        const load = refresh().finally(() => {
            inflight = undefined;
        });
        inflight = load;
        return load;
    }

    return { gridFor };
}
