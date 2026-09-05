/**
 * The BFF process entry point: load config, build the app, listen.
 *
 * The listener binds `config.host`, whose default is `127.0.0.1` -- never
 * hardcode `0.0.0.0` here. A later Docker phase overrides `HOST=0.0.0.0`
 * via the environment for that context only; it must never become a
 * default or a hardcoded value in this file.
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp(config);

app.listen({ port: config.port, host: config.host }).catch((error: unknown) => {
    app.log.error(error, 'failed to start server');
    process.exitCode = 1;
});
