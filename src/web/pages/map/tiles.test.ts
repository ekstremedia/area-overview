import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { applyTiles, disposeTiles, preconnectOriginFor, tileUrlFor } from './tiles.js';

const SAFETY_TIMEOUT_MS = 4_000;

interface FakeTileLayer {
    url: string;
    fireLoad: () => void;
    once: (event: string, cb: () => void) => FakeTileLayer;
    addTo: (map: FakeMap) => FakeTileLayer;
}

interface FakeMap {
    layers: Set<FakeTileLayer>;
    removeLayer: (layer: FakeTileLayer) => void;
}

function firstLayer(map: FakeMap): FakeTileLayer {
    const [layer] = [...map.layers];
    if (!layer) throw new Error('expected at least one layer on the fake map');
    return layer;
}

function otherLayer(map: FakeMap, exclude: FakeTileLayer): FakeTileLayer {
    const layer = [...map.layers].find((candidate) => candidate !== exclude);
    if (!layer) throw new Error('expected a second layer on the fake map');
    return layer;
}

function createFakeMap(): FakeMap {
    const layers = new Set<FakeTileLayer>();
    return {
        layers,
        removeLayer: vi.fn((layer: FakeTileLayer) => {
            layers.delete(layer);
        }),
    };
}

function createFakeLeaflet(): { L: typeof Leaflet; tileLayerCalls: string[] } {
    const tileLayerCalls: string[] = [];
    const tileLayer = vi.fn((url: string) => {
        tileLayerCalls.push(url);
        const listeners: (() => void)[] = [];
        const layer: FakeTileLayer = {
            url,
            once: (_event, cb) => {
                listeners.push(cb);
                return layer;
            },
            addTo: (map) => {
                map.layers.add(layer);
                return layer;
            },
            fireLoad: () => {
                for (const cb of listeners) cb();
            },
        };
        return layer;
    });
    return { L: { tileLayer } as unknown as typeof Leaflet, tileLayerCalls };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('tileUrlFor', () => {
    it('returns the CARTO dark_all template and attribution for dark, unkeyed by default', () => {
        expect(tileUrlFor('dark')).toEqual({
            url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            attribution: '© OSM · © CARTO',
        });
    });

    it('returns the OSM standard template and attribution for light', () => {
        expect(tileUrlFor('light')).toEqual({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution: '© OpenStreetMap',
        });
    });

    it('appends ?key= to the dark URL when a CARTO API key is given', () => {
        expect(tileUrlFor('dark', 'my-carto-key')).toEqual({
            url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=my-carto-key',
            attribution: '© OSM · © CARTO',
        });
    });

    it('leaves the dark URL unkeyed for an empty CARTO API key', () => {
        expect(tileUrlFor('dark', '')).toEqual({
            url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            attribution: '© OSM · © CARTO',
        });
    });

    it('URL-encodes the key', () => {
        expect(tileUrlFor('dark', 'a/b c').url).toContain('?key=a%2Fb%20c');
    });

    it('ignores a CARTO API key given for the light theme (OSM needs no key)', () => {
        expect(tileUrlFor('light', 'my-carto-key')).toEqual({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution: '© OpenStreetMap',
        });
    });
});

describe('preconnectOriginFor', () => {
    it('drops the {s}. subdomain placeholder for CARTO', () => {
        expect(preconnectOriginFor('dark')).toBe('https://basemaps.cartocdn.com');
    });

    it('is the OSM tile host for light (no placeholder to drop)', () => {
        expect(preconnectOriginFor('light')).toBe('https://tile.openstreetmap.org');
    });
});

describe('applyTiles', () => {
    it('threads the CARTO API key through to the tile layer URL', () => {
        const { L, tileLayerCalls } = createFakeLeaflet();
        const map = createFakeMap() as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark', 'my-carto-key');

        expect(tileLayerCalls).toEqual(['https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=my-carto-key']);
    });

    it('re-applies (rather than no-op) when a key arrives after an unkeyed dark layer is already showing', () => {
        const { L, tileLayerCalls } = createFakeLeaflet();
        const map = createFakeMap() as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark');
        applyTiles(L, map, 'dark', 'my-carto-key');

        expect(tileLayerCalls).toEqual([
            'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=my-carto-key',
        ]);
    });

    it('is a no-op when called again with the same theme (URL unchanged)', () => {
        const { L, tileLayerCalls } = createFakeLeaflet();
        const map = createFakeMap() as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark');
        applyTiles(L, map, 'dark');

        expect(tileLayerCalls).toHaveLength(1);
    });

    it('adds the new layer before removing the old one, and does not remove the old layer synchronously', () => {
        const { L } = createFakeLeaflet();
        const fakeMap = createFakeMap();
        const map = fakeMap as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark');
        expect(fakeMap.layers.size).toBe(1);
        const darkLayer = firstLayer(fakeMap);

        applyTiles(L, map, 'light');

        // The new (light) layer is already added; the old (dark) layer is
        // still present too -- removal has NOT happened synchronously.
        expect(fakeMap.layers.size).toBe(2);
        expect(fakeMap.removeLayer).not.toHaveBeenCalled();
        expect(fakeMap.layers.has(darkLayer)).toBe(true);
    });

    it('removes the old layer once the new layer fires "load"', () => {
        const { L } = createFakeLeaflet();
        const fakeMap = createFakeMap();
        const map = fakeMap as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark');
        const darkLayer = firstLayer(fakeMap);
        applyTiles(L, map, 'light');
        const lightLayer = otherLayer(fakeMap, darkLayer);

        lightLayer.fireLoad();

        expect(fakeMap.layers.size).toBe(1);
        expect(fakeMap.removeLayer).toHaveBeenCalledWith(darkLayer);
    });

    it('removes the old layer after the 4s safety timeout even if "load" never fires', () => {
        const { L } = createFakeLeaflet();
        const fakeMap = createFakeMap();
        const map = fakeMap as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark');
        const darkLayer = firstLayer(fakeMap);
        applyTiles(L, map, 'light');

        vi.advanceTimersByTime(SAFETY_TIMEOUT_MS - 1);
        expect(fakeMap.layers.has(darkLayer)).toBe(true);

        vi.advanceTimersByTime(1);
        expect(fakeMap.layers.has(darkLayer)).toBe(false);
    });

    it('does not double-remove if "load" fires after the safety timeout already settled it', () => {
        const { L } = createFakeLeaflet();
        const fakeMap = createFakeMap();
        const map = fakeMap as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark');
        const darkLayer = firstLayer(fakeMap);
        applyTiles(L, map, 'light');
        const lightLayer = otherLayer(fakeMap, darkLayer);

        vi.advanceTimersByTime(SAFETY_TIMEOUT_MS);
        expect(fakeMap.removeLayer).toHaveBeenCalledTimes(1);

        lightLayer.fireLoad();
        expect(fakeMap.removeLayer).toHaveBeenCalledTimes(1);
    });
});

describe('applyTiles / rapid successive calls', () => {
    it('carries forward an older pending safety timer so disposeTiles clears it too, not just the newest', () => {
        const { L } = createFakeLeaflet();
        const fakeMap = createFakeMap();
        const map = fakeMap as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark'); // call 1: no previous layer
        applyTiles(L, map, 'light'); // call 2: previousLayer = dark; its safety timer is still pending
        applyTiles(L, map, 'dark'); // call 3 (rapid theme switch back), before call 2 settles

        disposeTiles(map);
        const removeLayerCallsAfterDispose = vi.mocked(fakeMap.removeLayer).mock.calls.length;

        // Neither call 2's nor call 3's now-orphaned safety timer may fire after
        // disposal -- both must have been cleared by disposeTiles, not just the
        // most recent one.
        vi.advanceTimersByTime(SAFETY_TIMEOUT_MS);
        expect(vi.mocked(fakeMap.removeLayer).mock.calls.length).toBe(removeLayerCallsAfterDispose);
    });
});

describe('disposeTiles', () => {
    it('removes the currently-applied layer and clears the safety timer', () => {
        const { L } = createFakeLeaflet();
        const fakeMap = createFakeMap();
        const map = fakeMap as unknown as Leaflet.Map;

        applyTiles(L, map, 'dark');
        expect(fakeMap.layers.size).toBe(1);

        disposeTiles(map);

        expect(fakeMap.layers.size).toBe(0);

        // No pending safety timer should fire and try to remove anything further.
        vi.advanceTimersByTime(10_000);
        expect(fakeMap.removeLayer).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for a map that never had tiles applied', () => {
        const fakeMap = createFakeMap();
        expect(() => {
            disposeTiles(fakeMap as unknown as Leaflet.Map);
        }).not.toThrow();
    });
});
