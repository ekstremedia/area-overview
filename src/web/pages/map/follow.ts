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
 * - a manual pan or zoom -- a map move with a real gesture behind it, see
 *   `onMoveStart`;
 * - the reset-view control (a gesture, so the same path) and the idle
 *   reset, which says the display has returned itself to neutral;
 * - the popup's own button, which reads "stop following" while this
 *   vessel is the one being followed.
 *
 * Emphatically *not* ended by: the tab being changed, the mouse moving
 * over the map, a poll landing, or Leaflet re-measuring its container.
 * The first version cancelled on any `movestart` at all and the app moves
 * the map for plenty of reasons the visitor never asked for.
 */
import type * as Leaflet from 'leaflet';
import { signal, type ReadonlySignal } from '../../core/signal.js';
import { holdAutoCycle } from '../../shell/autoCycle.js';
import { IDLE_RESET_EVENT } from '../../shell/idle.js';

export interface Position {
    lat: number;
    lng: number;
}

export interface FollowTarget {
    /** The vessel's own id -- an MMSI or an ICAO address -- which is what a popup compares against to know whether it is the one being followed. */
    id: string;
    /** What the chip names it: a ship's name, an aircraft's callsign. */
    label: string;
    /**
     * Which live layer this vessel belongs to.
     *
     * Both layers run a motion frame, and only the one that owns the
     * followed vessel may recentre the map -- two of them doing it from
     * two slightly different instants is the jitter `advanceFollow` exists
     * to avoid. Stated here rather than inferred from "is it in my latest
     * response", which was the same thing right up until the vessel
     * slipped out of the viewport, and then became a trap: the layer
     * stopped recentring, so the vessel drifted further out, so it stayed
     * missing. A follow could never recover from a single missed frame.
     */
    layer: 'ships' | 'aircraft';
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
 * up -- and, in the layers, how long they keep answering for it from its
 * last known fix so the map can go on tracking it meanwhile.
 *
 * Not on the first miss: a ship absent from one poll has not gone
 * anywhere (a cluster, a gap in AIS coverage), and an aircraft blinking
 * out for a poll or two is the normal state of ADS-B over Vesterålen --
 * `canvasGlyphLayer`'s own `coastMs` exists for exactly that. Past this
 * the vessel really has gone, and a map holding station over empty water
 * with a chip naming a ship nobody can see is worse than letting go.
 */
export const LOSE_AFTER_MS = 30_000;

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

/**
 * How long after a real input event a map move still counts as the
 * visitor's doing.
 *
 * Generous on purpose: the gap between letting go of a drag and Leaflet's
 * inertia settling, or between a tap on a zoom button and its animation
 * starting, is well inside this -- while nothing the app does on its own
 * schedule (an idle reset, a container re-measure after a tab comes back,
 * a poll) lands within a second of the visitor touching anything.
 */
const GESTURE_WINDOW_MS = 1_000;

/** How often the follow checks whether its vessel is still being reported. Slow: this is a giving-up clock, not the thing that moves the map. */
const WATCHDOG_MS = 1_000;

/**
 * How often the owning layer redraws, and so how often the map is put
 * back under the vessel, while a follow is running.
 *
 * Faster than the ordinary `MOTION_FRAME_MS` (120ms, chosen to spare the
 * Raspberry Pi): at eight frames a second an airliner covers five pixels
 * between frames, and that shows as stepping however well the map and the
 * glyph agree. Following is a deliberate, temporary mode applied to one
 * vessel, so paying for smoothness here is a bargain the kiosk can afford.
 */
export const FOLLOW_FRAME_MS = 33;

interface ActiveFollow {
    map: Leaflet.Map;
    positionOf: () => Position | undefined;
    /** When the visitor last actually did something to this map -- see `GESTURE_WINDOW_MS`. */
    lastGestureAt: number;
    stop: () => void;
}

/** The live follow, or `null` when nothing is being followed. */
let active: ActiveFollow | null = null;

/**
 * Puts the map back under the followed vessel, if there is one.
 *
 * Called by whichever glyph layer owns that vessel, from inside the same
 * motion frame that has just redrawn it (`canvasGlyphLayer`'s
 * `onMotionFrame`) -- and that is the whole point. A timer of its own,
 * however closely matched in period, drifts out of phase with the layer's
 * within seconds, and then each frame moves the map from one instant's
 * dead reckoning while the glyph is still drawn from the previous one's.
 * The vessel appears to jitter back and forth along its own track, worst
 * for the fastest things on the map. Sharing the frame makes the glyph
 * sit still: both positions come from the same instant, so the vessel
 * stays pinned and the tiles slide under it.
 */
export function advanceFollow(): void {
    if (active === null || document.hidden) return;
    // Yield while the visitor is touching the map. Recentring runs often
    // enough to interrupt Leaflet's own zoom animation before it can take
    // effect -- the zoom would be silently undone, and, worse, the
    // `movestart` that should have ended the follow never arrived, so the
    // map could not be zoomed at all while following. Standing off for a
    // moment lets their gesture land and cancel this properly.
    if (Date.now() - active.lastGestureAt <= GESTURE_WINDOW_MS) return;
    const at = active.positionOf();
    if (at === undefined) return;
    const map = active.map;
    // `animate: false`: this is not a journey to somewhere, it is the map
    // being kept under something. An animation would still be running when
    // the next frame replaced it.
    moveProgrammatically(() => {
        map.setView([at.lat, at.lng], map.getZoom(), { animate: false });
    });
}

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
    const container = map.getContainer();

    /**
     * Accumulated rather than measured from a start time, and only across
     * ticks that actually ran: while the tab is hidden nothing is polled,
     * nothing is drawn and nobody is looking, so a vessel cannot
     * meaningfully be "missing" then. Measured against a wall clock
     * instead, a kiosk whose display slept for an hour would come back and
     * drop the follow on its first tick.
     */
    let missingForMs = 0;
    let lastTickAt: number | null = null;
    /**
     * Whether this follow has ever been able to place its vessel.
     *
     * Once it has, a `positionOf` that comes back empty means the layer
     * itself has given up -- it holds the last fix for `LOSE_AFTER_MS` of
     * its own (see either layer's `followedMemory`) -- so waiting out a
     * second full window here would keep the map, and the slideshow, held
     * for twice as long as this module documents.
     */
    let everPlaced = false;

    function noteGesture(): void {
        if (active !== null) active.lastGestureAt = Date.now();
    }

    /**
     * A drag in progress counts as a gesture for as long as it lasts.
     *
     * `pointerdown` alone was not enough: press, hold for a second, then
     * drag, and the move arrived outside `GESTURE_WINDOW_MS` -- so the
     * follow neither yielded to the drag nor ended, and the map could not
     * be taken back. Guarded on `buttons` because a bare `pointermove` is
     * the mouse merely crossing the map, which must leave a follow alone.
     */
    function noteDrag(event: Event): void {
        if (event instanceof PointerEvent && event.buttons === 0) return;
        noteGesture();
    }

    function onMoveStart(): void {
        if (isProgrammaticMove()) return; // our own recentring
        // A map move on its own is not the visitor: an idle reset putting
        // the home view back, Leaflet re-measuring its container after the
        // tab comes back, a catch-up poll's `invalidateSize` -- all of
        // them used to drop the follow out from under someone who had
        // done nothing but watch.
        if (active === null || Date.now() - active.lastGestureAt > GESTURE_WINDOW_MS) return;
        stopFollowing();
    }

    function onIdleReset(): void {
        // The display has put itself back to neutral, and the home view and
        // a follow cannot both have the map. This one is not a gesture, but
        // it is a deliberate return to a known state, so the follow yields.
        stopFollowing();
    }

    // The "zoom into it" half. Snapped rather than animated: `advanceFollow`
    // will be putting the map where the vessel is within a frame or two
    // anyway, and an animation still running when that lands is what
    // stuttering looks like.
    const at = positionOf();
    if (at !== undefined) {
        moveProgrammatically(() => {
            map.setView([at.lat, at.lng], Math.max(map.getZoom(), VESSEL_ZOOM), { animate: false });
        });
    }

    // Capture phase: Leaflet's own controls call `stopPropagation` on their
    // clicks (`disableClickPropagation`), so a bubble-phase listener would
    // never see a tap on the zoom buttons -- and a zoom is exactly the kind
    // of gesture that should take the map back.
    const GESTURES = ['pointerdown', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'touchstart', 'touchend'] as const;
    const DRAG_GESTURES = ['pointermove', 'touchmove'] as const;
    for (const type of GESTURES) container.addEventListener(type, noteGesture, { capture: true, passive: true });
    for (const type of DRAG_GESTURES) container.addEventListener(type, noteDrag, { capture: true, passive: true });
    map.on('movestart', onMoveStart);
    window.addEventListener(IDLE_RESET_EVENT, onIdleReset);

    const watchdog = setInterval(() => {
        if (document.hidden) {
            lastTickAt = null;
            return;
        }
        const now = Date.now();
        const elapsedMs = lastTickAt === null ? 0 : now - lastTickAt;
        lastTickAt = now;
        if (positionOf() !== undefined) {
            everPlaced = true;
            missingForMs = 0;
            return;
        }
        if (everPlaced) {
            stopFollowing(); // the layer has already waited its own `LOSE_AFTER_MS`
            return;
        }
        // Never placed at all: give it the same window to turn up before
        // giving up, rather than dropping a follow the instant it starts.
        missingForMs += elapsedMs;
        if (missingForMs >= LOSE_AFTER_MS) stopFollowing();
    }, WATCHDOG_MS);

    active = {
        map,
        positionOf,
        lastGestureAt: 0,
        stop(): void {
            clearInterval(watchdog);
            map.off('movestart', onMoveStart);
            window.removeEventListener(IDLE_RESET_EVENT, onIdleReset);
            for (const type of GESTURES) container.removeEventListener(type, noteGesture, { capture: true });
            for (const type of DRAG_GESTURES) container.removeEventListener(type, noteDrag, { capture: true });
            releaseAutoCycle();
        },
    };
    target.set(next);
}

/** Stops following, releases the slideshow, and leaves the map exactly where it is. Safe to call when nothing is being followed. */
export function stopFollowing(): void {
    active?.stop();
    active = null;
    target.set(null);
}
