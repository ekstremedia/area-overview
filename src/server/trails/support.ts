/**
 * Wires the trail stores to the two upstreams and to the routes that read
 * them: one place that knows a trail exists, so `app.ts` only has to
 * start and stop it and the routes only have to be handed a store.
 *
 * The ships poller reads the same `ShipsSnapshot` the route does, rather
 * than holding its own BarentsWatch token and issuing its own nationwide
 * fetch. It used to do the latter deliberately -- one extra token bought
 * the poller independence from route construction order -- but that trade
 * only made sense while the fetch itself was cheap to duplicate. It is a
 * multi-megabyte nationwide download, and the whole point of the snapshot
 * is that the process makes exactly one of them per refresh window, so
 * `app.ts` now builds the token and the snapshot and hands both consumers
 * the same slot.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Aircraft } from '../../shared/schemas/aircraft.js';
import type { Ship } from '../../shared/schemas/ships.js';
import { fetchAircraft } from '../aircraft/provider.js';
import type { ServerConfig } from '../config.js';
import { clampBbox, parseBbox, type Bbox } from '../layers/bbox.js';
import { shipsWithin } from '../ships/barentswatch.js';
import type { ShipsSnapshot } from '../ships/snapshot.js';
import { ok, type Result } from '../../shared/result.js';
import { startTrailPoller, type TrailPollerSource } from './poller.js';
import { createTrailStore, type TrailStore } from './store.js';

/**
 * Positions kept per vessel, and how far back in time they may reach.
 *
 * 40 points at the 30s default poll is ~20 minutes of track, which the
 * 30-minute window then bounds in wall-clock terms for anything polled
 * more often. `FORGET_AFTER_MS` is what stops a box running for weeks
 * from remembering every vessel that ever passed: an hour after a vessel
 * was last seen, it is gone from memory entirely.
 */
const MAX_POINTS = 40;
const MAX_AGE_MS = 30 * 60_000;
const FORGET_AFTER_MS = 60 * 60_000;

export interface TrailSupport {
    ships: TrailStore<Ship>;
    aircraft: TrailStore<Aircraft>;
    /** Starts the background poll. Returns its stop function; `app.ts` calls that on close. */
    start: (logger: FastifyBaseLogger) => () => void;
}

/** The configured area, or `null` when `TRAILS_AREA_BBOX` doesn't parse -- a bad value disables background polling rather than taking the server down, since trails are an enhancement and the routes work without them. */
function areaBbox(config: ServerConfig, logger: FastifyBaseLogger): Bbox | null {
    const parsed = parseBbox(config.trailsAreaBbox);
    if (!parsed.ok) {
        logger.error(
            { value: config.trailsAreaBbox, reason: parsed.error.message },
            'TRAILS_AREA_BBOX is not a valid bbox; background trail polling is off',
        );
        return null;
    }
    return clampBbox(parsed.value);
}

export interface TrailSupportDependencies {
    /** The one nationwide AIS slot, shared with `GET /api/ships`. `undefined` when BarentsWatch is unconfigured, which disables the ships half of the poll. */
    shipsSnapshot: ShipsSnapshot | undefined;
}

export function createTrailSupport(config: ServerConfig, dependencies: TrailSupportDependencies): TrailSupport {
    const storeOptions = { maxPoints: MAX_POINTS, maxAgeMs: MAX_AGE_MS, forgetAfterMs: FORGET_AFTER_MS };

    const ships = createTrailStore<Ship>(
        { idOf: (ship) => ship.mmsi, positionOf: (ship) => ({ lat: ship.lat, lng: ship.lng, at: ship.timestamp }) },
        storeOptions,
    );
    const aircraft = createTrailStore<Aircraft>(
        { idOf: (item) => item.icao, positionOf: (item) => ({ lat: item.lat, lng: item.lng, at: item.timestamp }) },
        storeOptions,
    );

    // `fetchOpenSky` treats any credentials object as "authenticate", so
    // an empty pair would send it after a token it cannot get instead of
    // making the anonymous request. Same construction as the aircraft
    // route's.
    const openSkyCredentials =
        config.openskyClientId !== '' && config.openskyClientSecret !== ''
            ? { clientId: config.openskyClientId, clientSecret: config.openskyClientSecret }
            : undefined;

    function start(logger: FastifyBaseLogger): () => void {
        if (!config.trailsEnabled) return (): void => undefined;

        const area = areaBbox(config, logger);
        if (!area) return (): void => undefined;

        const sources: TrailPollerSource[] = [];

        const shipsSnapshot = dependencies.shipsSnapshot;
        if (shipsSnapshot) {
            sources.push({
                name: 'ships',
                poll: async (now): Promise<Result<void>> => {
                    // Shares the route's snapshot, so this poll usually
                    // costs nothing upstream at all: whichever of the two
                    // asks first inside a refresh window pays for the
                    // fetch and the other reads the same ships out.
                    const result = await shipsSnapshot.ships();
                    if (!result.ok) return result;
                    ships.record(shipsWithin(result.value, area), now);
                    return ok(undefined);
                },
            });
        }

        sources.push({
            name: 'aircraft',
            poll: async (now): Promise<Result<void>> => {
                const result = await fetchAircraft(area, {
                    provider: config.adsbProvider,
                    upstreamTimeoutMs: config.upstreamTimeoutMs,
                    openSkyCredentials,
                });
                if (!result.ok) return result;
                aircraft.record(result.value.aircraft, now);
                return ok(undefined);
            },
        });

        if (sources.length === 0) return (): void => undefined;

        logger.info(
            { area, intervalSeconds: config.trailsPollSeconds, sources: sources.map((source) => source.name) },
            'background trail polling started',
        );
        return startTrailPoller(sources, { intervalMs: config.trailsPollSeconds * 1000, logger });
    }

    return { ships, aircraft, start };
}
