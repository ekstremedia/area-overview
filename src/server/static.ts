/**
 * Serves the built frontend (`dist/web`) in production, with SPA fallback
 * to `index.html` for any non-`/api` route so client-side routing works
 * on a hard refresh/deep link. In dev, Vite's own dev server serves the
 * frontend directly, so this plugin only registers when a build actually
 * exists on disk -- registering it unconditionally would make `npm run
 * dev:server` warn about (or serve stale content from) a directory that
 * isn't there yet.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const WEB_DIST_DIR = path.resolve(process.cwd(), 'dist/web');

/**
 * Synchronous by design: `app.register(...)` only *queues* a plugin for
 * Fastify's own boot sequence, it doesn't need (and must not be) awaited
 * here. Wrapping this in an `async` function and calling it fire-and-forget
 * (`void registerStaticPlugin(app)`) races Fastify's internal boot state --
 * `app.register` ends up called after `app.ready()`/`inject()` has already
 * started, which hangs the request instead of erroring.
 */
export function registerStaticPlugin(app: FastifyInstance): void {
    if (!existsSync(WEB_DIST_DIR)) {
        return;
    }

    app.register(fastifyStatic, {
        root: WEB_DIST_DIR,
    });

    app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api')) {
            reply.code(404).send({ error: 'Not found' });
            return;
        }
        reply.sendFile('index.html');
    });
}
