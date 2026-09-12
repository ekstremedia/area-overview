/**
 * What a request line records.
 *
 * `/api/weather` and `/api/tide` take `?lat&lng`, so Fastify's default
 * `req.url` serializer would write a stream of visitor positions into the
 * container log and keep them for as long as the logs are kept. Positions
 * are rounded to ~1km before they leave the browser and are never
 * persisted server-side; logging them would quietly undo both halves of
 * that, so it is asserted rather than assumed.
 */
import { describe, expect, it, vi } from 'vitest';
import weatherFixture from '../shared/fixtures/weather.json' with { type: 'json' };
import { buildApp } from './app.js';
import { testConfig } from './routes/test-helpers.js';

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Captures everything the app's logger writes, by giving pino a stream of our own. */
async function captureLogOutput(run: (app: ReturnType<typeof buildApp>) => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const app = buildApp(testConfig(), {
        logger: {
            level: 'info',
            stream: {
                write(chunk: string) {
                    chunks.push(chunk);
                },
            },
        },
    });
    await run(app);
    await app.close();
    return chunks.join('');
}

describe('request logging', () => {
    it('records the route template, never the query string a position travels in', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(weatherFixture))),
        );

        const output = await captureLogOutput(async (app) => {
            await app.inject({ method: 'GET', url: '/api/weather?lat=59.91&lng=10.75' });
        });

        expect(output).toContain('/api/weather');
        expect(output).not.toContain('59.91');
        expect(output).not.toContain('10.75');
        expect(output).not.toContain('lat=');

        vi.unstubAllGlobals();
    });

    it('still records the method, so the log is worth reading', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(jsonResponse(weatherFixture))),
        );

        const output = await captureLogOutput(async (app) => {
            await app.inject({ method: 'GET', url: '/api/weather' });
        });

        expect(output).toContain('GET');

        vi.unstubAllGlobals();
    });
});

describe('error logging', () => {
    it('keeps a position out of the log even when the upstream fails', async () => {
        // The cache key embeds the coordinates, so logging it would leak
        // positions through the error path -- undoing on failure exactly
        // what the request serializer keeps on success.
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new Error('upstream down'))),
        );

        const output = await captureLogOutput(async (app) => {
            await app.inject({ method: 'GET', url: '/api/weather?lat=59.91&lng=10.75' });
        });

        expect(output).toContain('weather:point');
        expect(output).not.toContain('59.91');
        expect(output).not.toContain('10.75');

        vi.unstubAllGlobals();
    });
});
