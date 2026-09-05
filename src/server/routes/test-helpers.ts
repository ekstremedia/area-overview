/**
 * Test-only helpers shared by the route test files: a fast-TTL test
 * config (so staleness tests don't need to wait 30s) and small builders
 * for stubbed `fetch` responses.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../app.js';
import type { ServerConfig } from '../config.js';

/**
 * Route test files other than `settings.test.ts` never exercise the
 * settings store, but `buildApp` always wires one up (it reads the file at
 * boot). Pointing the default at a per-process temp path -- never at the
 * real repo's `data/` directory -- means those files never so much as
 * `stat` anything inside the actual project, let alone write to it.
 * `settings.test.ts` overrides this per-test with its own temp directory.
 */
const DEFAULT_TEST_SETTINGS_FILE = path.join(tmpdir(), `area-overview-test-settings-${randomUUID()}.json`);

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
        port: 8141,
        host: '127.0.0.1',
        upstreamBaseUrl: 'https://upstream.example',
        upstreamTimeoutMs: 1000,
        cacheTtlMs: 20,
        pointForecastTtlMs: 20,
        settingsPassword: 'test-password-at-least-16-chars',
        settingsFile: DEFAULT_TEST_SETTINGS_FILE,
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
