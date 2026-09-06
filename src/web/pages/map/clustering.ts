/**
 * Pure, Leaflet-free clustering geometry for the ships live layer (see
 * `glyphs.ts`'s doc comment for why this shape of module exists): given a
 * list of already-projected screen-pixel positions, groups points that are
 * within `thresholdPx` of each other's *running centroid* into a single
 * `Cluster<T>`. `ships.ts` is the only consumer -- it does the
 * `map.project()` work to turn lat/lng into `xPx`/`yPx` and the
 * `map.unproject()` work to turn a cluster's centroid back into a
 * placeable `LatLng`; this module never touches Leaflet.
 *
 * The algorithm is a single greedy left-to-right pass, not a spatial
 * index or an iterative/optimal clustering (e.g. k-means or a proper
 * DBSCAN): for each point, join the first existing cluster whose current
 * centroid is within `thresholdPx`, recomputing that cluster's centroid
 * immediately; otherwise start a new single-point cluster. This is a
 * deliberate simplification -- `/api/ships` is already bbox-filtered to
 * one viewport, so the input here is tens of points, not thousands, and
 * a perfectly optimal clustering is not worth the complexity. One
 * consequence worth knowing (see `clustering.test.ts`'s "chain" case): a
 * point can be close to an early *member* of a cluster yet fail to join
 * it, if the cluster's centroid has already drifted away from that
 * member by the time this point is considered -- greedy-by-centroid, not
 * greedy-by-nearest-member.
 */

export interface ClusterInputPoint<T> {
    id: string;
    xPx: number;
    yPx: number;
    data: T;
}

/**
 * `members` are just the input points' `data`, in the order they joined --
 * a single-member cluster (i.e. not actually clustered) keeps the same
 * shape as a multi-member one, with `id` equal to that sole member's own
 * `id`, so callers can treat every cluster uniformly rather than
 * special-casing "not really a cluster".
 */
export interface Cluster<T> {
    id: string;
    xPx: number;
    yPx: number;
    members: T[];
}

interface WorkingCluster<T> {
    id: string;
    sumX: number;
    sumY: number;
    count: number;
    members: T[];
}

function distance(ax: number, ay: number, bx: number, by: number): number {
    return Math.hypot(ax - bx, ay - by);
}

/** Greedily groups `points` into clusters -- see this file's doc comment for the algorithm and its trade-offs. */
export function clusterPoints<T>(points: readonly ClusterInputPoint<T>[], thresholdPx: number): Cluster<T>[] {
    const working: WorkingCluster<T>[] = [];

    for (const point of points) {
        const target = working.find(
            (cluster) => distance(point.xPx, point.yPx, cluster.sumX / cluster.count, cluster.sumY / cluster.count) <= thresholdPx,
        );
        if (target) {
            target.sumX += point.xPx;
            target.sumY += point.yPx;
            target.count += 1;
            target.members.push(point.data);
        } else {
            working.push({ id: point.id, sumX: point.xPx, sumY: point.yPx, count: 1, members: [point.data] });
        }
    }

    return working.map((cluster) => ({
        id: cluster.id,
        xPx: cluster.sumX / cluster.count,
        yPx: cluster.sumY / cluster.count,
        members: cluster.members,
    }));
}
