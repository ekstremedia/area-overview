import { describe, expect, it } from 'vitest';
import { clusterPoints, type ClusterInputPoint } from './clustering.js';

function point(overrides: Partial<ClusterInputPoint<string>> = {}): ClusterInputPoint<string> {
    return { id: 'a', xPx: 0, yPx: 0, data: 'a', ...overrides };
}

describe('clusterPoints', () => {
    it('returns an empty array for empty input', () => {
        expect(clusterPoints([], 44)).toEqual([]);
    });

    it("returns one single-member cluster for a single point, id equal to that point's own id", () => {
        const a = point({ id: 'a', xPx: 10, yPx: 20, data: 'ship-a' });
        expect(clusterPoints([a], 44)).toEqual([{ id: 'a', xPx: 10, yPx: 20, members: ['ship-a'] }]);
    });

    it('groups two points within the threshold into one cluster centered on their centroid', () => {
        const a = point({ id: 'a', xPx: 0, yPx: 0, data: 'ship-a' });
        const b = point({ id: 'b', xPx: 10, yPx: 0, data: 'ship-b' });

        const result = clusterPoints([a, b], 44);

        expect(result).toEqual([{ id: 'a', xPx: 5, yPx: 0, members: ['ship-a', 'ship-b'] }]);
    });

    it('keeps two points far apart in separate single-member clusters', () => {
        const a = point({ id: 'a', xPx: 0, yPx: 0, data: 'ship-a' });
        const b = point({ id: 'b', xPx: 1000, yPx: 0, data: 'ship-b' });

        const result = clusterPoints([a, b], 44);

        expect(result).toEqual([
            { id: 'a', xPx: 0, yPx: 0, members: ['ship-a'] },
            { id: 'b', xPx: 1000, yPx: 0, members: ['ship-b'] },
        ]);
    });

    it('a chain of three where only the first two are close does not fully merge -- the third fails the centroid-distance check even though it was close to the original second point', () => {
        // a=(0,0), b=(10,0): 10 <= 12, merges to centroid (5,0).
        // c=(20,0): distance to centroid (5,0) is 15 > 12, so c does NOT
        // join, even though distance(b, c) is 10 <= 12 -- the greedy pass
        // checks against the current centroid, not the nearest member.
        const a = point({ id: 'a', xPx: 0, yPx: 0, data: 'ship-a' });
        const b = point({ id: 'b', xPx: 10, yPx: 0, data: 'ship-b' });
        const c = point({ id: 'c', xPx: 20, yPx: 0, data: 'ship-c' });

        const result = clusterPoints([a, b, c], 12);

        expect(result).toEqual([
            { id: 'a', xPx: 5, yPx: 0, members: ['ship-a', 'ship-b'] },
            { id: 'c', xPx: 20, yPx: 0, members: ['ship-c'] },
        ]);
    });
});
