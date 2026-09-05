/**
 * Builds a fully-configured Fastify instance without starting it. Kept
 * separate from `index.ts` so tests can exercise routes with
 * `app.inject()` -- no real port, no real network.
 */
import fastifyCompress from '@fastify/compress';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { registerAuroraRoutes } from './routes/aurora.js';
import { registerCameraRoutes } from './routes/cameras.js';
import { registerHealthzRoute } from './routes/healthz.js';
import { registerTideRoutes } from './routes/tide.js';
import { registerWeatherRoutes } from './routes/weather.js';
import { registerStaticPlugin } from './static.js';

export interface BuildAppOptions {
    /** Defaults to `true`; tests pass `false` to keep output quiet. */
    logger?: boolean;
}

export function buildApp(config: ServerConfig, options: BuildAppOptions = {}): FastifyInstance {
    const app = Fastify({ logger: options.logger ?? true });

    app.register(fastifyCompress);

    registerHealthzRoute(app, config);
    registerWeatherRoutes(app, config);
    registerAuroraRoutes(app, config);
    registerTideRoutes(app, config);
    registerCameraRoutes(app, config);

    registerStaticPlugin(app);

    return app;
}
