import { describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { signal } from '../../core/signal.js';
import { mapToBboxQuery, mountWhileEnabled } from './liveLayerMount.js';

interface FakeMapOptions {
    /** What Leaflet currently *thinks* the container is, i.e. its cached `getSize()`. */
    cachedSize: { x: number; y: number };
    /** What the container measurably *is* right now. */
    containerSize: { width: number; height: number };
}

/** A map whose cached size and real container size can disagree -- the exact state Leaflet is left in when a window resize lands while the tab is hidden, since its own re-measure is deferred to a `requestAnimationFrame` that never runs there. */
function fakeMap(options: FakeMapOptions) {
    const cached = { ...options.cachedSize };
    const invalidateSize = vi.fn(() => {
        cached.x = options.containerSize.width;
        cached.y = options.containerSize.height;
    });
    const map = {
        getContainer: () => ({ clientWidth: options.containerSize.width, clientHeight: options.containerSize.height }),
        getSize: () => ({ x: cached.x, y: cached.y }),
        invalidateSize,
        // Bounds derived from the *cached* size, the way Leaflet's own are:
        // a stale or zero size produces a correspondingly wrong rectangle.
        // Deliberately a plain multiple of the size rather than realistic
        // degrees -- the point each assertion below makes is *which size*
        // the bbox was derived from, and exact integers say that without
        // floating-point noise in the expected string.
        getBounds: () => ({
            getWest: () => cached.x,
            getSouth: () => cached.y,
            getEast: () => cached.x * 2,
            getNorth: () => cached.y * 2,
        }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { map: map as any as Leaflet.Map, invalidateSize };
}

describe('mapToBboxQuery', () => {
    it('asks Leaflet to re-measure when its cached size no longer matches the container, and describes the real viewport', () => {
        const { map, invalidateSize } = fakeMap({ cachedSize: { x: 200, y: 100 }, containerSize: { width: 1000, height: 600 } });

        const bbox = mapToBboxQuery(map);

        expect(invalidateSize).toHaveBeenCalledTimes(1);
        // Derived from the 1000x600 container, not the stale 200x100
        // Leaflet had cached (which would read '200,100,400,200').
        expect(bbox).toBe('1000,600,2000,1200');
    });

    it('does no Leaflet work at all when the cached size already matches the container', () => {
        const { map, invalidateSize } = fakeMap({ cachedSize: { x: 1000, y: 600 }, containerSize: { width: 1000, height: 600 } });

        expect(mapToBboxQuery(map)).toBe('1000,600,2000,1200');
        expect(invalidateSize).not.toHaveBeenCalled();
    });

    it('returns null rather than a point-sized bbox when the container has no size yet', () => {
        // Both sizes zero: re-measuring cannot help, the container simply
        // is not laid out. A bbox here would be a single point, and the
        // empty answer to it would read as a genuine "no ships here".
        const { map } = fakeMap({ cachedSize: { x: 0, y: 0 }, containerSize: { width: 0, height: 0 } });

        expect(mapToBboxQuery(map)).toBeNull();
    });
});

describe('mountWhileEnabled', () => {
    it('mounts immediately when already enabled', () => {
        let mounted = false;
        const dispose = mountWhileEnabled(
            () => true,
            () => {
                mounted = true;
                return () => {
                    mounted = false;
                };
            },
        );
        expect(mounted).toBe(true);
        dispose();
        expect(mounted).toBe(false);
    });

    it('does not mount at all while disabled', () => {
        let mountCount = 0;
        const dispose = mountWhileEnabled(
            () => false,
            () => {
                mountCount += 1;
                return () => undefined;
            },
        );
        expect(mountCount).toBe(0);
        dispose();
    });

    it('mounts when a reactive enabled signal flips true, and unmounts when it flips back to false', () => {
        const enabled = signal(false);
        let mountCount = 0;
        let disposeCount = 0;

        const dispose = mountWhileEnabled(
            () => enabled.get(),
            () => {
                mountCount += 1;
                return () => {
                    disposeCount += 1;
                };
            },
        );

        expect(mountCount).toBe(0);

        enabled.set(true);
        expect(mountCount).toBe(1);
        expect(disposeCount).toBe(0);

        enabled.set(false);
        expect(disposeCount).toBe(1);

        enabled.set(true);
        expect(mountCount).toBe(2);

        dispose();
        expect(disposeCount).toBe(2);
    });

    it("the outer dispose() tears down an inner mount that's still active, with no leak", () => {
        const enabled = signal(true);
        let disposeCount = 0;

        const dispose = mountWhileEnabled(
            () => enabled.get(),
            () => () => {
                disposeCount += 1;
            },
        );

        dispose();
        expect(disposeCount).toBe(1);

        // Flipping the signal after outer disposal must not remount --
        // the effect itself is torn down.
        enabled.set(false);
        enabled.set(true);
        expect(disposeCount).toBe(1);
    });
});
