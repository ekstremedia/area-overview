/**
 * Cameras section (artboard 07): one row per camera from the shared
 * `camerasResource` (also used by the map/cameras pages), each with a
 * name, an autosave-state indicator, the `camera_id`/upstream `location`
 * hint, and -- for a placed camera -- lat/lng `NumberField`s plus a
 * "fjern"/"remove" control; an unplaced camera shows only the
 * "Uten plassering"/"Unplaced" line, matching artboard 07's Spjutvika row.
 *
 * Rows are keyed by `camera_id` and built once; a poll that only changes
 * lat/lng updates the existing `NumberField`s in place via `.update()`
 * (never clobbering an in-progress edit -- same guard as every other
 * debounced field in this phase). The placed/unplaced *shape* of a row
 * only gets rebuilt when that boolean itself flips (an explicit user
 * action -- remove, or a placement appearing from another device --
 * never a background poll noise event), not on every settings poll tick.
 *
 * "Plasser på kart" (tap-to-place from the map) is NOT implemented in
 * this phase -- see the PR description for why it was cut under time
 * pressure. Removing a placement shows a plain, non-blocking "Fjernet ·
 * trykk her for å angre" undo affordance instead of a native `confirm()`,
 * per this app's house style.
 */
import type { Camera } from '../../../shared/schemas/camera.js';
import { PlacementSchema, type Placement } from '../../../shared/schemas/settings.js';
import { numberField, type NumberFieldHandle } from '../../components/NumberField.js';
import { toggle, type ToggleHandle } from '../../components/Toggle.js';
import { withCameraEnabled } from '../cameras/enabledCameras.js';
import { saveIndicator } from '../../components/SaveIndicator.js';
import type { AutosaveStatus } from '../../settings/autosave.js';
import { camerasResource } from '../../camera-resource.js';
import { effect, signal, type Signal } from '../../core/signal.js';
import { formatTime, t } from '../../i18n/index.js';
import type { SectionMount } from './sectionContext.js';

const UNDO_WINDOW_MS = 6000;

export interface RowHandle {
    el: HTMLElement;
    cameraId: string;
    isPlaced: boolean;
    update: (camera: Camera, placement: Placement | null, loggedIn: boolean, enabled: boolean) => void;
    dispose: () => void;
}

function buildUnplacedDetail(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'camera-row-unplaced';
    el.textContent = t('settings.cameras.unplaced');
    return el;
}

function buildPlacedDetail(
    cameraId: string,
    draft: Placement,
    loggedIn: boolean,
    write: (placement: Placement) => ReturnType<import('../../settings/sharedStore.js').SettingsStore['setPlacement']>,
    onRemove: () => void,
    /** The camera's display name, used to say which camera the on-screen keyboard is editing. */
    cameraLabel: string,
): { el: HTMLElement; latField: NumberFieldHandle; lngField: NumberFieldHandle } {
    const el = document.createElement('div');
    el.className = 'camera-row-fields';

    // `draft` is owned by the caller (`buildRow`), not copied here, so that
    // `write()`'s retry closure can always read the CURRENT lat/lng values
    // (including edits made to the other field after this write started)
    // rather than closing over a stale snapshot.
    const latField = numberField({
        value: draft.lat,
        schema: PlacementSchema.shape.lat,
        step: '0.0001',
        disabled: !loggedIn,
        id: `camera-${cameraId}-lat`,
        write: (value) => {
            draft.lat = value;
            return write({ ...draft });
        },
    });
    const lngField = numberField({
        value: draft.lng,
        schema: PlacementSchema.shape.lng,
        step: '0.0001',
        disabled: !loggedIn,
        id: `camera-${cameraId}-lng`,
        write: (value) => {
            draft.lng = value;
            return write({ ...draft });
        },
    });

    const latBlock = document.createElement('div');
    latBlock.className = 'settings-field';
    const latLabel = document.createElement('div');
    latLabel.className = 'settings-field-label';
    latLabel.textContent = t('settings.map.lat');
    // Names this field on the on-screen keyboard's caption, so the tray
    // says which camera and which coordinate it is editing.
    latField.input.dataset.keyboardContext = `${cameraLabel} · ${t('settings.map.lat')}`;
    latBlock.append(latLabel, latField.el);

    const lngBlock = document.createElement('div');
    lngBlock.className = 'settings-field';
    const lngLabel = document.createElement('div');
    lngLabel.className = 'settings-field-label';
    lngLabel.textContent = t('settings.map.lng');
    lngField.input.dataset.keyboardContext = `${cameraLabel} · ${t('settings.map.lng')}`;
    lngBlock.append(lngLabel, lngField.el);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'camera-row-remove';
    removeButton.textContent = t('settings.cameras.remove');
    removeButton.disabled = !loggedIn;
    removeButton.addEventListener('click', onRemove);

    el.append(latBlock, lngBlock, removeButton);
    return { el, latField, lngField };
}

// Exported so a test can assert `isPlaced`'s *liveness* on the returned
// handle directly (see `Cameras.test.ts`'s "returns a live isPlaced" test) --
// `mount()`'s own tests only assert on rendered DOM, which the pre-fix bug
// (a snapshotted, not live, `isPlaced` property) would not have caught.
export function buildRow(
    camera: Camera,
    placement: Placement | null,
    ctx: { store: import('../../settings/sharedStore.js').SettingsStore; loggedIn: boolean; enabled: boolean },
): RowHandle {
    const { store } = ctx;
    let loggedIn = ctx.loggedIn;

    const root = document.createElement('div');
    root.className = 'camera-row';

    const header = document.createElement('div');
    header.className = 'camera-row-header';
    const nameEl = document.createElement('div');
    nameEl.className = 'camera-row-name';
    nameEl.textContent = camera.name;

    const indicatorStatus: Signal<AutosaveStatus> = signal({ kind: 'idle' });
    const indicatorSlot = document.createElement('div');

    // Switching a camera off hides it from the cameras page, the map and
    // the camera count -- see `enabledCameras.ts`. The row itself stays,
    // placement fields and all, so turning it back on restores exactly
    // what was there rather than asking for the position again.
    const enabledToggle: ToggleHandle = toggle({
        accessibleLabel: t('settings.cameras.enabled'),
        checked: ctx.enabled,
        disabled: !loggedIn,
        onChange: (checked) => {
            void store.patchSettings({ disabledCameras: withCameraEnabled(store.settings.get().disabledCameras, camera.camera_id, checked) });
        },
    });

    header.append(nameEl, enabledToggle.el, indicatorSlot);

    const meta = document.createElement('div');
    meta.className = 'camera-row-meta';
    meta.textContent = `${camera.camera_id} · «${camera.location}»`;

    const detailSlot = document.createElement('div');

    root.append(header, meta, detailSlot);

    // Tracked so the keyboard caption names the camera by its *current*
    // name, not the one it had when this row was first built.
    let latestName = camera.name;
    let fields: { latField: NumberFieldHandle; lngField: NumberFieldHandle } | undefined;
    let isPlaced = placement !== null;
    let removedPlacement: Placement | null = null;
    let undoTimer: ReturnType<typeof setTimeout> | undefined;
    // The live lat/lng draft for the currently-rendered placed detail, owned
    // here (not inside `buildPlacedDetail`) so `write()`'s retry can always
    // recompose from the CURRENT values rather than a stale snapshot.
    let placementDraft: Placement | null = null;
    // Monotonically increasing token: if a newer write (e.g. editing lng)
    // starts while an older one (e.g. editing lat) is still in flight, the
    // older one's eventual resolution must not clobber the shared
    // `indicatorStatus` with its own (possibly out-of-order) result -- same
    // pattern as `autosave.ts`'s `inFlightToken`.
    let writeToken = 0;
    // While an undo affordance is showing, `update()` still tracks
    // `isPlaced` silently (so it knows the true state once the window
    // closes) but must not touch the DOM -- otherwise the very settings
    // change `store.setPlacement(null)` causes would immediately replace
    // the undo button with the plain "unplaced" text.
    let showingUndo = false;

    function setIndicatorIdleLabel(placed: boolean): void {
        indicatorStatus.set({ kind: 'idle' });
        currentIdleLabel = placed ? t('settings.status.saved') : t('settings.cameras.unplaced');
    }

    /** "Lagret 12:41" -- the artboard timestamps the save, so a glance says whether an edit actually landed. */
    function setIndicatorSavedAt(at: Date): void {
        currentIdleLabel = t('settings.status.savedAt', { time: formatTime(at) });
    }
    let currentIdleLabel = '';

    function write(next: Placement): ReturnType<typeof store.setPlacement> {
        const token = ++writeToken;
        indicatorStatus.set({ kind: 'saving' });
        const promise = store.setPlacement(camera.camera_id, next);
        void promise.then((result) => {
            if (token !== writeToken) return; // superseded by a newer write to this row; ignore this stale result

            if (result.ok) {
                indicatorStatus.set({ kind: 'saved' });
                setIndicatorSavedAt(new Date());
                setTimeout(() => {
                    if (token === writeToken) indicatorStatus.set({ kind: 'idle' });
                }, 1500);
            } else {
                indicatorStatus.set({
                    kind: 'error',
                    message: result.error.message,
                    retry: () => {
                        // Recompose from the CURRENT draft, not `next` -- the
                        // other field may have been edited since this write
                        // was originally issued.
                        void write(placementDraft ? { ...placementDraft } : next);
                    },
                });
            }
        });
        return promise;
    }

    function renderDetail(placement2: Placement | null): void {
        detailSlot.innerHTML = '';
        fields = undefined;
        if (placement2 === null) {
            placementDraft = null;
            detailSlot.append(buildUnplacedDetail());
            setIndicatorIdleLabel(false);
            return;
        }
        placementDraft = { ...placement2 };
        const built = buildPlacedDetail(
            camera.camera_id,
            placementDraft,
            loggedIn,
            write,
            () => {
                removedPlacement = placement2;
                showingUndo = true;
                void store.setPlacement(camera.camera_id, null);
                showUndo();
            },
            latestName,
        );
        fields = { latField: built.latField, lngField: built.lngField };
        detailSlot.append(built.el);
        setIndicatorIdleLabel(true);
    }

    function showUndo(): void {
        detailSlot.innerHTML = '';
        const undoButton = document.createElement('button');
        undoButton.type = 'button';
        undoButton.className = 'camera-row-undo';
        undoButton.textContent = t('settings.cameras.removedUndo');
        detailSlot.append(undoButton);
        clearTimeout(undoTimer);
        undoTimer = setTimeout(() => {
            removedPlacement = null;
            showingUndo = false;
            renderDetail(null);
        }, UNDO_WINDOW_MS);
        undoButton.addEventListener('click', () => {
            if (removedPlacement) {
                const restored = removedPlacement;
                removedPlacement = null;
                showingUndo = false;
                clearTimeout(undoTimer);
                void store.setPlacement(camera.camera_id, restored);
            }
        });
    }

    renderDetail(placement);

    const indicatorEffect = effect(() => {
        indicatorSlot.innerHTML = '';
        indicatorSlot.append(saveIndicator({ status: indicatorStatus.get(), idleLabel: currentIdleLabel }));
    });

    function update(nextCamera: Camera, nextPlacement: Placement | null, nextLoggedIn: boolean, nextEnabled: boolean): void {
        loggedIn = nextLoggedIn;
        latestName = nextCamera.name;
        nameEl.textContent = nextCamera.name;
        meta.textContent = `${nextCamera.camera_id} · «${nextCamera.location}»`;
        enabledToggle.setState(nextEnabled, !loggedIn);

        const nextIsPlaced = nextPlacement !== null;
        if (showingUndo) {
            // Track the true state silently; the undo affordance's own
            // timeout/click handlers decide when to actually re-render.
            isPlaced = nextIsPlaced;
            return;
        }
        if (nextIsPlaced !== isPlaced) {
            isPlaced = nextIsPlaced;
            renderDetail(nextPlacement);
            return;
        }
        if (nextPlacement && fields) {
            const latFocused = document.activeElement === fields.latField.input;
            const lngFocused = document.activeElement === fields.lngField.input;
            if (!latFocused) fields.latField.update(nextPlacement.lat, !loggedIn);
            if (!lngFocused) fields.lngField.update(nextPlacement.lng, !loggedIn);
        }
    }

    function dispose(): void {
        indicatorEffect();
        clearTimeout(undoTimer);
    }

    return {
        el: root,
        cameraId: camera.camera_id,
        // A live getter, not a snapshotted property: `{ isPlaced }` shorthand
        // would copy the `let` variable's value at the moment this object is
        // created, which can be stale before placement data finishes loading
        // on first render -- `update()` reassigns the `isPlaced` variable
        // afterward, and this getter must observe that reassignment.
        get isPlaced() {
            return isPlaced;
        },
        update,
        dispose,
    };
}

export const mount: SectionMount = (container, ctx) => {
    const root = document.createElement('div');
    root.className = 'settings-section-cameras';
    container.append(root);

    const rows = new Map<string, RowHandle>();

    const disposeEffect = effect(() => {
        const state = camerasResource.state.get();
        const cameras = state.status === 'ready' ? state.data.cameras : state.status === 'error' ? (state.lastData?.cameras ?? []) : [];
        const settings = ctx.store.settings.get();
        const seen = new Set<string>();

        for (const camera of cameras) {
            seen.add(camera.camera_id);
            const placement = settings.placements[camera.camera_id] ?? null;
            const enabled = !settings.disabledCameras.includes(camera.camera_id);
            const existing = rows.get(camera.camera_id);
            if (existing) {
                existing.update(camera, placement, ctx.loggedIn, enabled);
            } else {
                const row = buildRow(camera, placement, { store: ctx.store, loggedIn: ctx.loggedIn, enabled });
                rows.set(camera.camera_id, row);
                root.append(row.el);
            }
        }

        for (const [cameraId, row] of rows) {
            if (!seen.has(cameraId)) {
                row.dispose();
                row.el.remove();
                rows.delete(cameraId);
            }
        }
    });

    return function dispose(): void {
        disposeEffect();
        for (const row of rows.values()) row.dispose();
        root.remove();
    };
};
