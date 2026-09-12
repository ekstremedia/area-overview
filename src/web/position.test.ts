import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Re-imported per test: both modules read `localStorage` once at import time. */
async function freshModules(): Promise<{
    position: typeof import('./position.js');
    overrides: typeof import('./settings/localOverrides.js');
}> {
    vi.resetModules();
    const overrides = await import('./settings/localOverrides.js');
    const position = await import('./position.js');
    return { position, overrides };
}

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    localStorage.clear();
});

describe('activePosition', () => {
    it('is null while this device follows the shared home view', async () => {
        const { position } = await freshModules();

        expect(position.activePosition.get()).toBeNull();
    });

    it('is the overridden position once this device has one', async () => {
        const { position, overrides } = await freshModules();

        overrides.setLocalOverride('homeView', { lat: 59.91, lng: 10.75, zoom: 12 });

        expect(position.activePosition.get()).toEqual({ lat: 59.91, lng: 10.75 });
    });

    it('rounds a hand-typed override, which can carry full precision', async () => {
        // The locate control already rounds, but the settings page lets
        // someone type coordinates in directly -- and a position must not
        // leave this browser finer than `geolocation.ts` promises.
        const { position, overrides } = await freshModules();

        overrides.setLocalOverride('homeView', { lat: 59.913869, lng: 10.752245, zoom: 12 });

        expect(position.activePosition.get()).toEqual({ lat: 59.91, lng: 10.75 });
    });

    it('goes back to null when the override is handed back', async () => {
        const { position, overrides } = await freshModules();
        overrides.setLocalOverride('homeView', { lat: 59.91, lng: 10.75, zoom: 12 });

        overrides.clearLocalOverride('homeView');

        expect(position.activePosition.get()).toBeNull();
    });
});

describe('positionQuery', () => {
    it('is empty for the home position, so the kiosk and every ordinary visitor share one URL', async () => {
        const { position } = await freshModules();

        expect(position.positionQuery()).toBe('');
    });

    it('carries lat and lng -- never lon -- for an overridden position', async () => {
        const { position, overrides } = await freshModules();

        overrides.setLocalOverride('homeView', { lat: 59.91, lng: 10.75, zoom: 12 });

        const query = position.positionQuery();
        expect(query).toBe('?lat=59.91&lng=10.75');
        expect(query).not.toContain('lon=');
    });

    it('URL-encodes a negative longitude correctly', async () => {
        const { position, overrides } = await freshModules();

        overrides.setLocalOverride('homeView', { lat: 40.42, lng: -3.7, zoom: 12 });

        expect(position.positionQuery()).toBe('?lat=40.42&lng=-3.7');
    });
});
