/**
 * Builds a fully-configured Fastify instance without starting it. Kept
 * separate from `index.ts` so tests can exercise routes with
 * `app.inject()` -- no real port, no real network.
 */
import fastifyCompress from '@fastify/compress';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import { registerAuroraRoutes } from './routes/aurora.js';
import type { OvationClient } from './aurora/ovation.js';
import { registerCameraRoutes } from './routes/cameras.js';
import { registerAircraftRoutes } from './routes/aircraft.js';
import { registerHealthzRoute } from './routes/healthz.js';
import { registerMapConfigRoute } from './routes/map-config.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerShipsRoutes } from './routes/ships.js';
import { createOutboundGate } from './outbound-gate.js';
import { createShipsSnapshot } from './ships/snapshot.js';
import { createBarentsWatchToken } from './ships/token.js';
import { registerTideRoutes } from './routes/tide.js';
import { registerWeatherRoutes } from './routes/weather.js';
import { registerStaticPlugin } from './static.js';
import { createTrailSupport } from './trails/support.js';

export interface BuildAppOptions {
    /**
     * Defaults to on. Tests pass `false` to keep output quiet, or a pino
     * options object (a `stream`, say) to capture what is written --
     * `logRequest` below is merged in either way, so a test cannot
     * accidentally assert against a serializer production does not use.
     */
    logger?: boolean | Record<string, unknown>;
    /**
     * Overrides the settings auth failure delay (production default:
     * 1000ms, see `requireSettingsPassword`). Test-only: never set this
     * from `index.ts` or from any environment variable -- the delay is a
     * security property, not something a deployment should be able to
     * turn down.
     */
    settingsAuthFailureDelayMs?: number;
    /** Test-only: an `OvationClient` standing in for NOAA, so the aurora route's point path can be driven without a network call. */
    ovation?: OvationClient;
}

/**
 * What a request line records.
 *
 * Fastify's default serializer logs `req.url`, which includes the query
 * string -- and since `/api/weather` and `/api/tide` now take `?lat&lng`,
 * that would write a stream of visitor positions into the container log
 * and keep them there for as long as the logs are kept. Positions are
 * rounded to ~1km before they ever leave the browser and are never
 * persisted server-side; writing them to a log would quietly undo both
 * halves of that.
 *
 * The route *template* (`/api/weather`, not `/api/weather?lat=59.91...`)
 * is what is actually useful for reading traffic anyway.
 */
function logRequest(request: FastifyRequest): { method: string; path: string; remoteAddress: string } {
    return {
        method: request.method,
        // The template, not the concrete URL: `/api/weather`, never
        // `/api/weather?lat=59.91&lng=10.75`.
        path: request.routeOptions.url ?? '<unrouted>',
        remoteAddress: request.ip,
    };
}

function buildLoggerOption(logger: BuildAppOptions['logger']): false | Record<string, unknown> {
    if (logger === false) return false;
    const provided = typeof logger === 'object' ? logger : {};
    const providedSerializers = (provided.serializers ?? {}) as Record<string, unknown>;
    // `logRequest` last, so it is what production and tests alike get.
    return { ...provided, serializers: { ...providedSerializers, req: logRequest } };
}

export function buildApp(config: ServerConfig, options: BuildAppOptions = {}): FastifyInstance {
    const app = Fastify({
        logger: buildLoggerOption(options.logger),
    });

    app.register(fastifyCompress);

    registerHealthzRoute(app, config);
    registerMapConfigRoute(app, config);
    // Registered before the weather route because that route needs the
    // store: the Netatmo gate reads `settings.weather.useNetatmo` and
    // `settings.homeView` on every request, and there must be exactly one
    // store (it owns the file and its write queue).
    const settingsStore = registerSettingsRoutes(
        app,
        config,
        options.settingsAuthFailureDelayMs === undefined ? {} : { authFailureDelayMs: options.settingsAuthFailureDelayMs },
    );

    registerWeatherRoutes(app, config, {
        settings: settingsStore,
        ...(options.settingsAuthFailureDelayMs === undefined ? {} : { authFailureDelayMs: options.settingsAuthFailureDelayMs }),
    });
    registerAuroraRoutes(app, config, options.ovation === undefined ? {} : { ovation: options.ovation });
    registerTideRoutes(app, config);
    registerCameraRoutes(app, config);
    // One BarentsWatch token and one nationwide AIS slot for the whole
    // process, built here rather than inside either consumer because both
    // `GET /api/ships` and the background trail poller must share them --
    // that sharing is what keeps the upstream cost at one fetch per
    // refresh window however many viewports are being served. See
    // `ships/snapshot.ts`.
    const shipsConfigured = config.barentswatchClientId !== '' && config.barentswatchClientSecret !== '';
    const shipsSnapshot = shipsConfigured
        ? createShipsSnapshot(createBarentsWatchToken(config.barentswatchClientId, config.barentswatchClientSecret, config.upstreamTimeoutMs), {
              upstreamTimeoutMs: config.upstreamTimeoutMs,
              refreshMs: config.shipsSnapshotRefreshMs,
              maxStaleMs: config.shipsSnapshotMaxStaleMs,
          })
        : undefined;

    // Shared by the routes and the background poller: the routes read
    // trails out and feed their own fetches in, the poller keeps it warm
    // while nobody is on the map page. See `trails/support.ts`.
    // One ADS-B budget for the whole process, spent by the route and the
    // background poller alike. The aggregators are free, keyless community
    // services that see one caller -- this app -- however many people have
    // the map open. See `outbound-gate.ts`.
    const aircraftGate = createOutboundGate({ minIntervalMs: config.adsbMinIntervalMs, burst: config.adsbBurst });

    const trails = createTrailSupport(config, { shipsSnapshot, aircraftGate });
    registerShipsRoutes(app, config, { trails: trails.ships, snapshot: shipsSnapshot });
    registerAircraftRoutes(app, config, { trails: trails.aircraft, gate: aircraftGate });
    registerStaticPlugin(app);

    // Started once the server is up (never during `buildApp`, so a test
    // that only injects requests makes no upstream calls) and stopped on
    // close, so a poll timer can't outlive the instance that owns it.
    let stopTrailPolling: (() => void) | undefined;
    app.addHook('onReady', function startPolling(this: FastifyInstance, done) {
        stopTrailPolling = trails.start(this.log);
        done();
    });
    app.addHook('onClose', (_instance, done) => {
        stopTrailPolling?.();
        stopTrailPolling = undefined;
        done();
    });

    return app;
}
