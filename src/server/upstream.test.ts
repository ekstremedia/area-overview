import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import { fetchUpstream } from './upstream.js';

const config: ServerConfig = {
    port: 8141,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://upstream.example',
    upstreamTimeoutMs: 8000,
    cacheTtlMs: 30_000,
    pointForecastTtlMs: 60_000,
    settingsPassword: 'test-password-at-least-16-chars',
    settingsFile: 'data/settings.json',
};

const TestSchema = z.object({ value: z.number() });

describe('fetchUpstream', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('returns ok(...) with parsed data for a valid response', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ value: 42 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        );

        const result = await fetchUpstream('/api/test', TestSchema, config);

        expect(result).toEqual({ ok: true, value: { value: 42 } });
    });

    it('returns err(...) for a schema-invalid body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ value: 'not-a-number' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        );

        const result = await fetchUpstream('/api/test', TestSchema, config);

        expect(result.ok).toBe(false);
    });

    it('returns err(...) for a non-2xx status', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 })));

        const result = await fetchUpstream('/api/test', TestSchema, config);

        expect(result.ok).toBe(false);
    });

    it('returns err(...) on a simulated timeout', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
                return new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        reject(new DOMException('The operation was aborted', 'TimeoutError'));
                    });
                });
            }),
        );

        const result = await fetchUpstream('/api/test', TestSchema, {
            ...config,
            upstreamTimeoutMs: 1,
        });

        expect(result.ok).toBe(false);
    });
});
