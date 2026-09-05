/**
 * Settings routes -- the only write surface in the whole app. `GET` is
 * public (a kiosk display and every admin client need to read current
 * settings without a password); every other route requires
 * `requireSettingsPassword`.
 *
 * Deliberately not built on `serveCached`/`fetchUpstream`: those exist
 * for the proxy-with-TTL-cache pattern used by weather/aurora/tide/
 * cameras. This is a local read/write store with no upstream and no
 * cache headers at all -- settings can change from another device at
 * any moment, so an `ETag`/304 here would actively lie to a client that
 * polls it.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PlacementSchema, SettingsPatchSchema, type Settings } from '../../shared/schemas/settings.js';
import type { ServerConfig } from '../config.js';
import { requireSettingsPassword } from '../settings/auth.js';
import { SettingsStore, SettingsWritesRefusedError } from '../settings/store.js';

/**
 * `placements` are set exclusively through the dedicated PUT/DELETE
 * routes below, never through this general patch. `SettingsPatchSchema`
 * already omits `placements` from its shape, but Zod's default parsing
 * *silently strips* unrecognised keys rather than rejecting them -- so
 * without `.strict()`, a client sending `{ placements: {...} }` here
 * would get a quiet no-op instead of a clear error. `.strict()` turns
 * any unrecognised key (including `placements`, including `updatedAt`)
 * into a real 400.
 */
const StrictSettingsPatchSchema = SettingsPatchSchema.strict();

const CameraIdParamsSchema = z.object({ cameraId: z.string().min(1) });

async function writeAndRespond(reply: FastifyReply, write: () => Promise<Settings>): Promise<void> {
    try {
        const settings = await write();
        reply.send(settings);
    } catch (error) {
        if (error instanceof SettingsWritesRefusedError) {
            // `error.message` includes the resolved absolute settings file
            // path and the raw JSON/Zod parse failure text -- useful in a
            // server log, not something to hand back over an
            // internet-facing API. The detailed reason was already logged
            // server-side by `SettingsStore` (via its `logger.error` call)
            // when the refusal state was first entered.
            reply.code(503).send({ error: 'Settings are temporarily read-only; check server logs.' });
            return;
        }
        throw error;
    }
}

export interface RegisterSettingsRoutesOptions {
    /** Test-only override for `requireSettingsPassword`'s failure delay. See `BuildAppOptions.settingsAuthFailureDelayMs`. */
    authFailureDelayMs?: number;
}

export function registerSettingsRoutes(app: FastifyInstance, config: ServerConfig, options: RegisterSettingsRoutesOptions = {}): SettingsStore {
    const store = new SettingsStore(config.settingsFile, {
        logger: {
            error: (message: string) => {
                app.log.error(message);
            },
        },
    });
    const requireAuth = requireSettingsPassword(config, options.authFailureDelayMs);

    // Fastify's own `ready()`/`inject()`/`listen()` lifecycle waits for
    // every `onReady` hook, so this load always completes before the
    // first request can be served -- same guarantee `registerStaticPlugin`
    // relies on for its own async plugin registration.
    app.addHook('onReady', async () => {
        await store.load();
    });

    app.get('/api/settings', async (_request, reply) => {
        reply.send(store.get());
    });

    app.post('/api/settings/login', { preHandler: requireAuth }, async (_request, reply) => {
        reply.code(204).send();
    });

    app.patch('/api/settings', { preHandler: requireAuth }, async (request, reply) => {
        const body = StrictSettingsPatchSchema.safeParse(request.body);
        if (!body.success) {
            reply.code(400).send({ error: 'Invalid settings patch', issues: body.error.issues });
            return;
        }

        await writeAndRespond(reply, () => store.patch(body.data));
    });

    app.put('/api/settings/placements/:cameraId', { preHandler: requireAuth }, async (request, reply) => {
        const params = CameraIdParamsSchema.safeParse(request.params);
        if (!params.success) {
            reply.code(400).send({ error: 'Invalid camera id' });
            return;
        }

        const body = PlacementSchema.safeParse(request.body);
        if (!body.success) {
            reply.code(400).send({ error: 'Invalid placement', issues: body.error.issues });
            return;
        }

        await writeAndRespond(reply, () => store.setPlacement(params.data.cameraId, body.data));
    });

    app.delete('/api/settings/placements/:cameraId', { preHandler: requireAuth }, async (request, reply) => {
        const params = CameraIdParamsSchema.safeParse(request.params);
        if (!params.success) {
            reply.code(400).send({ error: 'Invalid camera id' });
            return;
        }

        await writeAndRespond(reply, () => store.setPlacement(params.data.cameraId, null));
    });

    return store;
}
