import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/**
 * `SETTINGS_PASSWORD` is the one required-with-no-default field in this
 * schema, deliberately: a missing or too-short value must fail boot
 * loudly rather than run with a guessable/empty password. Every case
 * here goes through `loadConfig`'s optional `env` parameter -- never the
 * real `.env` file.
 */
const baseEnv = {
    PORT: '8141',
    HOST: '127.0.0.1',
    UPSTREAM_BASE_URL: 'https://upstream.example',
    UPSTREAM_TIMEOUT_MS: '8000',
    CACHE_TTL_MS: '30000',
    POINT_FORECAST_TTL_MS: '60000',
};

describe('loadConfig / SETTINGS_PASSWORD', () => {
    it('throws when SETTINGS_PASSWORD is missing entirely', () => {
        expect(() => loadConfig({ ...baseEnv })).toThrow();
    });

    it('throws when SETTINGS_PASSWORD is shorter than 16 characters', () => {
        expect(() => loadConfig({ ...baseEnv, SETTINGS_PASSWORD: '15characters!!!' })).toThrow();
    });

    it('never includes the attempted value in its error message', () => {
        const secretGuess = 'super-secret-guess-value';
        try {
            loadConfig({ ...baseEnv, SETTINGS_PASSWORD: secretGuess.slice(0, 10) });
            expect.unreachable('loadConfig should have thrown for a too-short password');
        } catch (error) {
            expect(String(error)).not.toContain(secretGuess.slice(0, 10));
        }
    });

    it('succeeds with a 16+ character password', () => {
        const config = loadConfig({ ...baseEnv, SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough' });
        expect(config.settingsPassword).toBe('a-test-password-that-is-long-enough');
    });

    it('defaults settingsFile to data/settings.json', () => {
        const config = loadConfig({ ...baseEnv, SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough' });
        expect(config.settingsFile).toBe('data/settings.json');
    });

    it('reads SETTINGS_FILE when provided', () => {
        const config = loadConfig({
            ...baseEnv,
            SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough',
            SETTINGS_FILE: './somewhere/settings.json',
        });
        expect(config.settingsFile).toBe('./somewhere/settings.json');
    });
});

describe('loadConfig / live-layer credentials', () => {
    it('defaults BarentsWatch credentials to empty strings and adsbProvider to adsblol', () => {
        const config = loadConfig({ ...baseEnv, SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough' });
        expect(config.barentswatchClientId).toBe('');
        expect(config.barentswatchClientSecret).toBe('');
        expect(config.adsbProvider).toBe('adsblol');
        expect(config.openskyClientId).toBe('');
        expect(config.openskyClientSecret).toBe('');
    });

    it('reads BarentsWatch credentials and adsbProvider when set', () => {
        const config = loadConfig({
            ...baseEnv,
            SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough',
            BARENTSWATCH_CLIENT_ID: 'a-client-id',
            BARENTSWATCH_CLIENT_SECRET: 'a-client-secret',
            ADSB_PROVIDER: 'opensky',
        });
        expect(config.barentswatchClientId).toBe('a-client-id');
        expect(config.barentswatchClientSecret).toBe('a-client-secret');
        expect(config.adsbProvider).toBe('opensky');
    });

    it('throws for an unrecognised ADSB_PROVIDER', () => {
        expect(() =>
            loadConfig({ ...baseEnv, SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough', ADSB_PROVIDER: 'unknown-provider' }),
        ).toThrow();
    });

    it('never includes a set BarentsWatch client secret in an unrelated error message', () => {
        const secret = 'super-secret-barentswatch-value';
        try {
            loadConfig({ ...baseEnv, SETTINGS_PASSWORD: 'too-short', BARENTSWATCH_CLIENT_SECRET: secret });
            expect.unreachable('loadConfig should have thrown for a too-short password');
        } catch (error) {
            expect(String(error)).not.toContain(secret);
        }
    });
});

describe('loadConfig / CARTO_API_KEY', () => {
    it('defaults cartoApiKey to an empty string', () => {
        const config = loadConfig({ ...baseEnv, SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough' });
        expect(config.cartoApiKey).toBe('');
    });

    it('reads CARTO_API_KEY when set', () => {
        const config = loadConfig({
            ...baseEnv,
            SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough',
            CARTO_API_KEY: 'a-test-carto-key',
        });
        expect(config.cartoApiKey).toBe('a-test-carto-key');
    });
});

describe('loadConfig / UPSTREAM_BASE_URL', () => {
    it('throws at boot when UPSTREAM_BASE_URL is not a valid URL', () => {
        expect(() =>
            loadConfig({
                ...baseEnv,
                UPSTREAM_BASE_URL: 'not-a-url',
                SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough',
            }),
        ).toThrow();
    });

    it('defaults to https://nesthus.no when unset', () => {
        const envWithoutUpstream: Record<string, string | undefined> = { ...baseEnv };
        envWithoutUpstream.UPSTREAM_BASE_URL = undefined;
        const config = loadConfig({ ...envWithoutUpstream, SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough' });
        expect(config.upstreamBaseUrl).toBe('https://nesthus.no');
    });

    it('accepts a well-formed UPSTREAM_BASE_URL', () => {
        const config = loadConfig({ ...baseEnv, SETTINGS_PASSWORD: 'a-test-password-that-is-long-enough' });
        expect(config.upstreamBaseUrl).toBe('https://upstream.example');
    });
});
