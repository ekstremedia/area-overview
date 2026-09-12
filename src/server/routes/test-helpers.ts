/**
 * Test-only helpers shared by the route test files: a fast-TTL test
 * config (so staleness tests don't need to wait 30s) and small builders
 * for stubbed `fetch` responses.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp, type BuildAppOptions } from '../app.js';
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
        settingsPassword: 'test-password-at-least-16-chars',
        settingsFile: DEFAULT_TEST_SETTINGS_FILE,
        barentswatchClientId: '',
        barentswatchClientSecret: '',
        adsbProvider: 'adsblol',
        openskyClientId: '',
        openskyClientSecret: '',
        shipsCacheTtlMs: 20,
        aircraftCacheTtlMs: 20,
        shipsSnapshotRefreshMs: 20,
        shipsSnapshotMaxStaleMs: 10 * 60_000,
        adsbMinIntervalMs: 2000,
        pointForecastTtlMs: 600_000,
        adsbBurst: 4,
        cartoApiKey: '',
        trailsPollSeconds: 30,
        trailsAreaBbox: '14.4,68.35,16.6,69.05',
        // Off in tests: a background poller would make real upstream calls
        // from a suite that otherwise touches no network.
        trailsEnabled: false,
        ...overrides,
    };
}

export function buildTestApp(overrides: Partial<ServerConfig> = {}, options: BuildAppOptions = {}) {
    // A short default failure delay keeps unrelated route tests (which
    // never touch settings auth) and settings-route tests alike fast;
    // `auth.test.ts` separately asserts the real production default is
    // still 1000ms via `requireSettingsPassword`'s own default parameter.
    return buildApp(testConfig(overrides), { logger: false, settingsAuthFailureDelayMs: 5, ...options });
}

/**
 * A real `Response` (unlike happy-dom's) refuses a non-null body on a
 * null-body status -- constructing one with a JSON string body would throw,
 * which previously let this helper build an invalid 204 fixture (`{ status:
 * 204, body: '...' }`) that silently diverges from what a real upstream can
 * ever send. Model that here: a null-body status always gets `null`, so a
 * caller can't accidentally assert against a shape upstream never produces.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function jsonResponse(body: unknown, status = 200): Response {
    if (NULL_BODY_STATUSES.has(status)) {
        return new Response(null, { status });
    }
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
