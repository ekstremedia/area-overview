/**
 * Following a vessel: the map centred on one ship or aircraft and held
 * there as it moves, with the slideshow's page timer held off for as long
 * as it lasts.
 *
 * The position it tracks is the dead-reckoned one (`motion.ts`), not the
 * last fix -- the same position the glyph itself is drawn at, recentred on
 * the same `MOTION_FRAME_MS` cadence, so the vessel sits still under the
 * middle of the screen instead of drifting away between polls and being
 * yanked back on each one.
 *
 * State lives at module scope rather than inside a layer because the
 * chip, both live layers and the map all need to agree on one answer to
 * "is anything being followed", and because only one thing can be
 * followed at a time by construction. `mountLiveLayers`' disposer clears
 * it when the map page goes away.
 *
 * How a follow ends, all four of them:
 *
 * - the chip's own stop button (`layers.ts`);
 * - any manual pan or zoom -- see `isProgrammaticMove` for how the map's
 *   own movements are told apart from the visitor's;
 * - the reset-view control and the idle reset, which get this for free:
 *   both call `setView` without the programmatic flag, so they read as a
 *   deliberate move away;
 * - the popup's own button, which reads "stop following" while this
 *   vessel is the one being followed.
 */
import type * as Leaflet from 'leaflet';
import { signal, type ReadonlySignal } from '../../core/signal.js';
import { holdAutoCycle } from '../../shell/autoCycle.js';
import { MOTION_FRAME_MS } from './motion.js';

export interface Position {
    lat: number;
    lng: number;
}

export interface FollowTarget {
    /** The vessel's own id -- an MMSI or an ICAO address -- which is what a popup compares against to know whether it is the one being followed. */
    id: string;
    /** What the chip names it: a ship's name, an aircraft's callsign. */
    label: string;
}

/**
 * How close the two popup actions settle on.
 *
 * About 1.5km across on the kiosk's 1024px display at this latitude:
 * close enough to see which quay a ship is at or which fjord it is
 * turning into, wide enough that its motion still reads as motion rather
 * than as a glyph tearing across the screen. Applied as a floor, never as
 * a setting -- someone already zoomed further in asked for that, and an
 * action called "zoom to" has no business zooming out.
 *
 * Deliberately not `layers.ts`'s `FOCUS_ZOOM` (13), which the masthead's
 * live list uses: that one is "show me roughly where this is" from a list
 * of things scattered across the map, this is "put me on it".
 */
export const VESSEL_ZOOM = 14;

/**
 * How long a followed vessel may go unreported before the follow gives
 * up.
 *
 * Not on the first miss: a ship absent from one poll has not gone
 * anywhere (a cluster, a gap in AIS coverage), and an aircraft blinking
 * out for a poll or two is the normal state of ADS-B over Vesterålen --
 * `canvasGlyphLayer`'s own `coastMs` exists for exactly that. Past this
 * the vessel really has gone, and a map holding station over empty water
 * with a chip naming a ship nobody can see is worse than letting go.
 */
const LOSE_AFTER_MS = 30_000;

const target = signal<FollowTarget | null>(null);

/** The vessel currently being followed, or `null`. Reactive: the chip and the popups both read it. */
export const followTarget: ReadonlySignal<FollowTarget | null> = target;

/** Whether `id` is the vessel currently being followed -- what a popup's button label turns on. */
export function isFollowing(id: string): boolean {
    return target.get()?.id === id;
}

/**
 * Depth, not a boolean: a programmatic move can nest (the follow's first
 * recentre happens inside `followVessel`, which is itself already inside
 * one), and a boolean would clear the flag at the end of the inner move
 * while the outer one was still running.
 */
let programmaticMoves = 0;

/**
 * Whether the map is moving because this app moved it.
 *
 * The follow recentres the map several times a second, and Leaflet
 * reports that exactly as it reports a visitor dragging the map: there is
 * no "user did this" flag on a move event. So the app raises one around
 * its own calls, and everything that cares -- the follow's own
 * cancel-on-pan, `liveLayerMount.ts`'s refetch-on-move -- asks here
 * rather than reacting to every move alike.
 */
export function isProgrammaticMove(): boolean {
    return programmaticMoves > 0;
}

function moveProgrammatically(move: () => void): void {
    programmaticMoves += 1;
    try {
        move();
    } finally {
        programmaticMoves -= 1;
    }
}

/**
 * Centres the map on `position`, zooming in to `VESSEL_ZOOM` unless it is
 * already closer. Animated, because nothing is competing with it -- the
 * follow's own recentring is not (see `followVessel`).
 */
export function zoomToVessel(map: Leaflet.Map, position: Position): void {
    moveProgrammatically(() => {
        map.setView([position.lat, position.lng], Math.max(map.getZoom(), VESSEL_ZOOM));
    });
}

/** The live follow's own teardown, or `null` when nothing is being followed. */
let active: (() => void) | null = null;

/**
 * Starts following `next`, asking `positionOf` where it has got to on
 * every frame.
 *
 * `positionOf` rather than a position or a descriptor: a vessel's
 * position changes between polls and again on every poll, and the layer
 * that owns the data is the only thing that can answer for it. It is also
 * what decouples this from how the vessel happens to be *drawn* -- a ship
 * swallowed into a cluster badge is still perfectly followable, and a
 * layer switched off in settings simply stops answering and the follow
 * lets go after `LOSE_AFTER_MS`.
 */
export function followVessel(map: Leaflet.Map, next: FollowTarget, positionOf: () => Position | undefined): void {
    stopFollowing();

    const releaseAutoCycle = holdAutoCycle();
    /**
     * Accumulated rather than measured from a start time, and only across
     * frames that actually ran: while the tab is hidden nothing is polled,
     * nothing is drawn and nobody is looking, so a vessel cannot
     * meaningfully be "missing" then. Measured against a wall clock
     * instead, a kiosk whose display slept for an hour would come back and
     * drop the follow on its first frame.
     */
    let missingForMs = 0;

    function recentre(elapsedMs: number): void {
        const at = positionOf();
        if (at === undefined) {
            missingForMs += elapsedMs;
            if (missingForMs >= LOSE_AFTER_MS) stopFollowing();
            return;
        }
        missingForMs = 0;
        // `animate: false` deliberately: at eight frames a second every
        // animation would be interrupted by the next one before it
        // finished, which looks like stutter rather than like smoothness.
        // The vessel is what moves here; the map is just kept under it.
        moveProgrammatically(() => {
            map.setView([at.lat, at.lng], map.getZoom(), { animate: false });
        });
    }

    function onMoveStart(): void {
        // The visitor took the wheel. Not our own recentring, which is
        // wrapped in the programmatic flag above.
        if (!isProgrammaticMove()) stopFollowing();
    }

    // The "zoom into it" half, before the cancel listener is armed so this
    // move cannot read as the visitor's. Snapped, not animated, for the
    // same reason `recentre` is: the frame timer below would cut a pan
    // animation short 120ms in.
    const at = positionOf();
    if (at !== undefined) {
        moveProgrammatically(() => {
            map.setView([at.lat, at.lng], Math.max(map.getZoom(), VESSEL_ZOOM), { animate: false });
        });
    }

    map.on('movestart', onMoveStart);
    // Skipped while the tab is hidden, like the glyph and trail timers:
    // there is nothing on screen to keep centred. `lastFrameAt` is dropped
    // rather than kept across the gap, so the hidden time is not charged
    // to the missing-vessel clock when the display comes back.
    let lastFrameAt: number | null = null;
    const timer = setInterval(() => {
        if (document.hidden) {
            lastFrameAt = null;
            return;
        }
        const now = Date.now();
        const elapsedMs = lastFrameAt === null ? 0 : now - lastFrameAt;
        lastFrameAt = now;
        recentre(elapsedMs);
    }, MOTION_FRAME_MS);

    active = function stop(): void {
        clearInterval(timer);
        map.off('movestart', onMoveStart);
        releaseAutoCycle();
    };
    target.set(next);
}

/** Stops following, releases the slideshow, and leaves the map exactly where it is. Safe to call when nothing is being followed. */
export function stopFollowing(): void {
    active?.();
    active = null;
    target.set(null);
}
