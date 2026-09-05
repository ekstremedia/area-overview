/**
 * Parses `docker-compose.yml` (and `.env.example`) directly and asserts the
 * one property that actually matters for safety: the app's port is only
 * ever reachable on loopback. This exists so an accidental future change
 * to a `0.0.0.0` publish -- the exact mistake that once made a different
 * project on this box reachable from the whole Wi-Fi network, bypassing
 * the reverse proxy entirely -- gets caught by CI, not discovered in
 * production.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// Vitest runs with cwd set to the repo root (see vitest.config.ts), same
// convention `src/server/settings/store.ts` relies on for its own paths --
// `import.meta.url` isn't reliably a `file:` URL under the happy-dom test
// environment this project uses, so it's not used here.
const REPO_ROOT = process.cwd();

interface ComposeFile {
    services: {
        app: {
            restart?: string;
            ports?: string[];
            environment?: Record<string, string> | string[];
        };
    };
}

function loadCompose(): ComposeFile {
    const raw = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf-8');
    return parse(raw) as ComposeFile;
}

describe('docker-compose.yml', () => {
    it('publishes every app port on loopback only', () => {
        const compose = loadCompose();
        const ports = compose.services.app.ports ?? [];

        expect(ports.length).toBeGreaterThan(0);
        for (const entry of ports) {
            expect(entry.startsWith('127.0.0.1:')).toBe(true);
        }
    });

    it('restarts unless-stopped', () => {
        const compose = loadCompose();

        expect(compose.services.app.restart).toBe('unless-stopped');
    });

    it('sets HOST=0.0.0.0 only inside the environment block, and only here', () => {
        const compose = loadCompose();
        const environment = compose.services.app.environment;

        expect(environment).toBeDefined();

        // `environment:` can be a mapping or a `KEY=value` list -- handle both
        // rather than assuming the shape this file happens to use today.
        const host = Array.isArray(environment) ? environment.find((entry) => entry.startsWith('HOST='))?.split('=')[1] : environment?.HOST;

        expect(host).toBe('0.0.0.0');
    });

    it('does not set HOST=0.0.0.0 in .env.example, which must stay safe for a native (non-Docker) run', () => {
        const envExample = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf-8');

        expect(envExample).not.toMatch(/^HOST=0\.0\.0\.0$/m);
    });
});
