/**
 * Test-only helpers shared by the route test files: a fast-TTL test
 * config (so staleness tests don't need to wait 30s) and small builders
 * for stubbed `fetch` responses.
 */
import { buildApp } from '../app.js';
import type { ServerConfig } from '../config.js';

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
        port: 8141,
        host: '127.0.0.1',
        upstreamBaseUrl: 'https://upstream.example',
        upstreamTimeoutMs: 1000,
        cacheTtlMs: 20,
        pointForecastTtlMs: 20,
        ...overrides,
    };
}

export function buildTestApp(overrides: Partial<ServerConfig> = {}) {
    return buildApp(testConfig(overrides), { logger: false });
}

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
