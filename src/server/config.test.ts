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
