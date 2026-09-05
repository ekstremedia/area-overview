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
import { saveIndicator } from '../../components/SaveIndicator.js';
import type { AutosaveStatus } from '../../settings/autosave.js';
import { camerasResource } from '../../camera-resource.js';
import { effect, signal, type Signal } from '../../core/signal.js';
import { t } from '../../i18n/index.js';
import type { SectionMount } from './sectionContext.js';

const UNDO_WINDOW_MS = 6000;

interface RowHandle {
    el: HTMLElement;
    cameraId: string;
    isPlaced: boolean;
    update: (camera: Camera, placement: Placement | null, loggedIn: boolean) => void;
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
    placement: Placement,
    loggedIn: boolean,
    write: (placement: Placement) => ReturnType<import('../../settings/sharedStore.js').SettingsStore['setPlacement']>,
    onRemove: () => void,
): { el: HTMLElement; latField: NumberFieldHandle; lngField: NumberFieldHandle } {
    const el = document.createElement('div');
    el.className = 'camera-row-fields';

    const draft: Placement = { ...placement };

    const latField = numberField({
        value: draft.lat,
        schema: PlacementSchema.shape.lat,
        step: '0.0001',
        disabled: !loggedIn,
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
    latBlock.append(latLabel, latField.el);

    const lngBlock = document.createElement('div');
    lngBlock.className = 'settings-field';
    const lngLabel = document.createElement('div');
    lngLabel.className = 'settings-field-label';
    lngLabel.textContent = t('settings.map.lng');
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

function buildRow(
    camera: Camera,
    placement: Placement | null,
    ctx: { store: import('../../settings/sharedStore.js').SettingsStore; loggedIn: boolean },
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

    header.append(nameEl, indicatorSlot);

    const meta = document.createElement('div');
    meta.className = 'camera-row-meta';
    meta.textContent = `${camera.camera_id} · «${camera.location}»`;

    const detailSlot = document.createElement('div');

    root.append(header, meta, detailSlot);

    let fields: { latField: NumberFieldHandle; lngField: NumberFieldHandle } | undefined;
    let isPlaced = placement !== null;
    let removedPlacement: Placement | null = null;
    let undoTimer: ReturnType<typeof setTimeout> | undefined;
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
    let currentIdleLabel = '';

    function write(next: Placement): ReturnType<typeof store.setPlacement> {
        indicatorStatus.set({ kind: 'saving' });
        const promise = store.setPlacement(camera.camera_id, next);
        void promise.then((result) => {
            if (result.ok) {
                indicatorStatus.set({ kind: 'saved' });
                setTimeout(() => {
                    indicatorStatus.set({ kind: 'idle' });
                }, 1500);
            } else {
                indicatorStatus.set({
                    kind: 'error',
                    message: result.error.message,
                    retry: () => {
                        void write(next);
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
            detailSlot.append(buildUnplacedDetail());
            setIndicatorIdleLabel(false);
            return;
        }
        const built = buildPlacedDetail(camera.camera_id, placement2, loggedIn, write, () => {
            removedPlacement = placement2;
            showingUndo = true;
            void store.setPlacement(camera.camera_id, null);
            showUndo();
        });
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

    function update(nextCamera: Camera, nextPlacement: Placement | null, nextLoggedIn: boolean): void {
        loggedIn = nextLoggedIn;
        nameEl.textContent = nextCamera.name;
        meta.textContent = `${nextCamera.camera_id} · «${nextCamera.location}»`;

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

    return { el: root, cameraId: camera.camera_id, isPlaced, update, dispose };
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
            const existing = rows.get(camera.camera_id);
            if (existing) {
                existing.update(camera, placement, ctx.loggedIn);
            } else {
                const row = buildRow(camera, placement, { store: ctx.store, loggedIn: ctx.loggedIn });
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
