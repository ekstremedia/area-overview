/**
 * Global Vitest setup: stubs `fetch` so that a module-scope singleton
 * like `src/web/settings-resource.ts` (which starts polling
 * `/api/settings` on import) never makes a real network call from a test
 * -- happy-dom's `fetch` otherwise happily attempts a real TCP
 * connection to `localhost`, which is slow, flaky and noisy
 * (`ECONNREFUSED` logged to the console) in an environment with no
 * server running. Tests that need to control settings values mock
 * `src/web/settings-resource.js` directly instead of relying on
 * this fetch stub's shape.
 */
import { vi } from 'vitest';

vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch is stubbed out in tests -- mock the module that calls it instead'))),
);
