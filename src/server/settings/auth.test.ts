import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { extractBearerToken, passwordsMatch, PRODUCTION_AUTH_FAILURE_DELAY_MS, requireSettingsPassword } from './auth.js';

const REAL_PASSWORD = 'a-real-password-that-is-long-enough';

// A short delay for test speed. A separate test below asserts the real
// production default is still 1000ms, without ever waiting for it.
const FAST_TEST_DELAY_MS = 5;

function fakeConfig(): ServerConfig {
    return {
        port: 8141,
        host: '127.0.0.1',
        upstreamBaseUrl: 'https://upstream.example',
        upstreamTimeoutMs: 1000,
        cacheTtlMs: 1000,
        settingsPassword: REAL_PASSWORD,
        settingsFile: 'data/settings.json',
        barentswatchClientId: '',
        barentswatchClientSecret: '',
        adsbProvider: 'adsblol',
        openskyClientId: '',
        openskyClientSecret: '',
        shipsCacheTtlMs: 10_000,
        aircraftCacheTtlMs: 10_000,
        shipsSnapshotRefreshMs: 10_000,
        shipsSnapshotMaxStaleMs: 10 * 60_000,
        adsbMinIntervalMs: 2000,
        adsbBurst: 4,
        cartoApiKey: '',
        trailsPollSeconds: 30,
        trailsAreaBbox: '14.4,68.35,16.6,69.05',
        // Off in tests: a background poller would make real upstream calls
        // from a suite that otherwise touches no network.
        trailsEnabled: false,
    };
}

/**
 * A real (but otherwise empty) Fastify app with a single route behind
 * `requireSettingsPassword`, exercised via `app.inject()` -- the same
 * pattern the rest of this codebase's route tests use, and one that
 * sidesteps hand-rolling a fake `FastifyReply` (which trips
 * `@typescript-eslint/unbound-method` on its mocked methods and is easy
 * to get subtly wrong).
 */
function buildAuthTestApp(delayMs = FAST_TEST_DELAY_MS) {
    const app = Fastify({ logger: false });
    app.get('/protected', { preHandler: requireSettingsPassword(fakeConfig(), delayMs) }, () => ({ reached: true }));
    return app;
}

describe('requireSettingsPassword', () => {
    it('the production default delay is 1000ms', () => {
        expect(PRODUCTION_AUTH_FAILURE_DELAY_MS).toBe(1000);
    });

    it('passes through to the handler with the correct password', async () => {
        const app = buildAuthTestApp();

        const response = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${REAL_PASSWORD}` } });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ reached: true });
    });

    it('responds 401 for a missing Authorization header', async () => {
        const app = buildAuthTestApp();

        const response = await app.inject({ method: 'GET', url: '/protected' });

        expect(response.statusCode).toBe(401);
    });

    it('responds 401 for a malformed header (no Bearer prefix)', async () => {
        const app = buildAuthTestApp();

        const response = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: REAL_PASSWORD } });

        expect(response.statusCode).toBe(401);
    });

    it('responds 401 for a wrong password', async () => {
        const app = buildAuthTestApp();

        const response = await app.inject({
            method: 'GET',
            url: '/protected',
            headers: { authorization: 'Bearer wrong-password-thats-also-long' },
        });

        expect(response.statusCode).toBe(401);
    });

    it('waits at least the configured delay before responding on failure', async () => {
        const app = buildAuthTestApp(50);

        const start = Date.now();
        const response = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer wrong' } });
        const elapsed = Date.now() - start;

        expect(response.statusCode).toBe(401);
        expect(elapsed).toBeGreaterThanOrEqual(45);
    });

    it('never includes the presented password in the 401 response body', async () => {
        const app = buildAuthTestApp();
        const presented = 'super-secret-guess-value-1234';

        const response = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${presented}` } });

        expect(response.body).not.toContain(presented);
    });
});

describe('extractBearerToken', () => {
    it('extracts the token from a well-formed header', () => {
        expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    });

    it('returns null for a missing header', () => {
        expect(extractBearerToken(undefined)).toBeNull();
    });

    it('returns null for a header without the Bearer prefix', () => {
        expect(extractBearerToken('abc123')).toBeNull();
    });

    it('returns null for an empty token', () => {
        expect(extractBearerToken('Bearer ')).toBeNull();
    });
});

describe('a wrong password of a different length than the real one', () => {
    it('is rejected, same as a same-length wrong guess', async () => {
        const app = buildAuthTestApp();

        // Deliberately a very different length from REAL_PASSWORD.
        const short = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer x' } });
        // Deliberately the same length as REAL_PASSWORD, still wrong.
        const sameLength = await app.inject({
            method: 'GET',
            url: '/protected',
            headers: { authorization: `Bearer ${'x'.repeat(REAL_PASSWORD.length)}` },
        });

        expect(short.statusCode).toBe(401);
        expect(sameLength.statusCode).toBe(401);
    });

    it('the underlying comparison (passwordsMatch) never throws for a mismatched-length input, proving it never reaches the length-sensitive branch of timingSafeEqual', () => {
        // Asserted via the implementation, not wall-clock timing (which
        // would be flaky, and which `node:crypto`'s module can't be
        // reliably intercepted for across module boundaries to spy on
        // directly). If `passwordsMatch` ever passed the raw,
        // differently-sized strings straight to `timingSafeEqual` instead
        // of first hashing both to fixed-length digests, a
        // mismatched-length call would throw here instead of returning
        // `false`.
        expect(() => passwordsMatch(REAL_PASSWORD, 'x')).not.toThrow();
        expect(passwordsMatch(REAL_PASSWORD, 'x')).toBe(false);

        expect(() => passwordsMatch(REAL_PASSWORD, 'x'.repeat(REAL_PASSWORD.length))).not.toThrow();
        expect(passwordsMatch(REAL_PASSWORD, 'x'.repeat(REAL_PASSWORD.length))).toBe(false);

        expect(passwordsMatch(REAL_PASSWORD, REAL_PASSWORD)).toBe(true);
    });
});
