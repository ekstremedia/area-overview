import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err, type Result } from '../../../shared/result.js';
import type { Camera, CameraListResponse } from '../../../shared/schemas/camera.js';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import type { ResourceState } from '../../core/resource.js';
import type { SettingsStore } from '../../settings/sharedStore.js';
import { fakeSettingsStore } from './test-helpers.js';

const camerasState = signal<ResourceState<CameraListResponse>>({ status: 'idle' });
vi.mock('../../camera-resource.js', () => ({ camerasResource: { state: camerasState } }));

const { mount, buildRow } = await import('./Cameras.js');

function camera(overrides: Partial<Camera> = {}): Camera {
    return {
        id: 1,
        camera_id: 'sigerfjord_01',
        name: 'Sigerfjord',
        description: null,
        location: 'Sigerfjordveien',
        current_image_url: null,
        current_image_updated_at: null,
        latest_video: null,
        video_count: 0,
        ...overrides,
    };
}

function setCameras(cameras: Camera[]): void {
    camerasState.set({ status: 'ready', data: { cameras, cached_at: new Date().toISOString() }, fetchedAt: new Date() });
}

function fakeStore(initial: Settings) {
    const settings = signal(initial);
    const setPlacement = vi.fn().mockImplementation((cameraId: string, placement: { lat: number; lng: number } | null) => {
        const placements =
            placement === null
                ? Object.fromEntries(Object.entries(settings.get().placements).filter(([id]) => id !== cameraId))
                : { ...settings.get().placements, [cameraId]: placement };
        settings.set({ ...settings.get(), placements });
        return Promise.resolve(ok(settings.get()));
    });
    const store: SettingsStore = fakeSettingsStore({ settings, patchSettings: vi.fn(), setPlacement, dispose: vi.fn() });
    return { store, settings, setPlacement };
}

beforeEach(() => {
    vi.useFakeTimers();
    camerasState.set({ status: 'idle' });
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('Cameras section', () => {
    it('renders a row per camera with name, camera_id/location, and placed fields when placed', () => {
        setCameras([camera()]);
        const { store } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const row = container.querySelector('.camera-row');
        expect(row?.querySelector('.camera-row-name')?.textContent).toBe('Sigerfjord');
        expect(row?.querySelector('.camera-row-meta')?.textContent).toBe('sigerfjord_01 · «Sigerfjordveien»');
        expect(row?.querySelectorAll('.number-field-input')).toHaveLength(2);

        dispose();
    });

    it('shows "Uten plassering" and no fields for an unplaced camera', () => {
        setCameras([camera({ camera_id: 'spjutvika_01', name: 'Spjutvika' })]);
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const row = container.querySelector('.camera-row');
        expect(row?.querySelector('.camera-row-unplaced')?.textContent).toContain('Uten plassering');
        expect(row?.querySelectorAll('.number-field-input')).toHaveLength(0);

        dispose();
    });

    it('offers to place an unplaced camera, seeding the shared home view', async () => {
        // Without this the row is a dead end: no coordinate fields to edit,
        // and so no way to discover that placing is possible at all.
        setCameras([camera({ camera_id: 'spjutvika_01', name: 'Spjutvika' })]);
        const { store, setPlacement } = fakeStore(SettingsSchema.parse({ homeView: { lat: 68.6984, lng: 15.4129, zoom: 11 } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        const place = container.querySelector<HTMLButtonElement>('.camera-row-place');
        expect(place?.disabled).toBe(false);
        place?.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(setPlacement).toHaveBeenCalledWith('spjutvika_01', { lat: 68.6984, lng: 15.4129 });
        // And the row becomes editable, rather than needing a reload.
        expect(container.querySelectorAll('.number-field-input')).toHaveLength(2);

        dispose();
    });

    it('does not offer to place a camera while logged out', () => {
        setCameras([camera({ camera_id: 'spjutvika_01', name: 'Spjutvika' })]);
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        expect(container.querySelector<HTMLButtonElement>('.camera-row-place')?.disabled).toBe(true);

        dispose();
    });

    it('editing lat debounces and sends a PUT with the full composed placement', async () => {
        setCameras([camera()]);
        const { store, setPlacement } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));
        const container = document.createElement('div');
        document.body.append(container);
        const dispose = mount(container, { store, loggedIn: true });

        const latInput = container.querySelector<HTMLInputElement>('.number-field-input');
        if (!latInput) throw new Error('lat input not found');
        latInput.focus();
        latInput.value = '68.72';
        latInput.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(500);

        expect(setPlacement).toHaveBeenCalledWith('sigerfjord_01', { lat: 68.72, lng: 15.4 });

        dispose();
    });

    it('removing a placement calls setPlacement(id, null) and shows an undo affordance', () => {
        setCameras([camera()]);
        const { store, setPlacement } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        container.querySelector<HTMLButtonElement>('.camera-row-remove')?.click();

        expect(setPlacement).toHaveBeenCalledWith('sigerfjord_01', null);
        expect(container.querySelector('.camera-row-undo')?.textContent).toBe('Fjernet · trykk for å angre');

        dispose();
    });

    it('clicking undo restores the removed placement', () => {
        setCameras([camera()]);
        const { store, setPlacement } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        container.querySelector<HTMLButtonElement>('.camera-row-remove')?.click();
        container.querySelector<HTMLButtonElement>('.camera-row-undo')?.click();

        expect(setPlacement).toHaveBeenLastCalledWith('sigerfjord_01', { lat: 68.7, lng: 15.4 });

        dispose();
    });

    it('removes a row when its camera disappears from the list', () => {
        setCameras([camera(), camera({ camera_id: 'spjutvika_01', name: 'Spjutvika' })]);
        const { store } = fakeStore(SettingsSchema.parse({}));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: true });

        expect(container.querySelectorAll('.camera-row')).toHaveLength(2);

        setCameras([camera()]);
        expect(container.querySelectorAll('.camera-row')).toHaveLength(1);

        dispose();
    });

    it('shows a saving/error indicator and a retry affordance on a failed write', async () => {
        setCameras([camera()]);
        const { store, setPlacement } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));
        setPlacement.mockResolvedValueOnce(err({ message: 'boom' }));
        const container = document.createElement('div');
        document.body.append(container);
        const dispose = mount(container, { store, loggedIn: true });

        const latInput = container.querySelector<HTMLInputElement>('.number-field-input');
        if (!latInput) throw new Error('lat input not found');
        latInput.focus();
        latInput.value = '68.72';
        latInput.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(500);
        await vi.waitFor(() => {
            expect(container.querySelector('.save-indicator--error')).not.toBeNull();
        });

        dispose();
    });

    it('overlapping lat/lng writes: an out-of-order-settling stale write must not clobber the shared indicator', async () => {
        setCameras([camera()]);
        const { store, setPlacement } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));

        let resolveLatWrite!: (result: Result<Settings>) => void;
        let resolveLngWrite!: (result: Result<Settings>) => void;
        setPlacement.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveLatWrite = resolve;
                }),
        );
        setPlacement.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveLngWrite = resolve;
                }),
        );

        const container = document.createElement('div');
        document.body.append(container);
        const dispose = mount(container, { store, loggedIn: true });

        const inputs = container.querySelectorAll<HTMLInputElement>('.number-field-input');
        const latInput = inputs[0];
        const lngInput = inputs[1];
        if (!latInput || !lngInput) throw new Error('lat/lng inputs not found');

        latInput.focus();
        latInput.value = '68.72';
        latInput.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(500); // lat's debounce fires -- write #1 in flight

        lngInput.focus();
        lngInput.value = '15.5';
        lngInput.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(500); // lng's debounce fires -- write #2 in flight

        expect(setPlacement).toHaveBeenCalledTimes(2);

        // The SECOND write (lng, started later) settles FIRST, successfully.
        resolveLngWrite(ok(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.72, lng: 15.5 } } })));
        await vi.waitFor(() => {
            expect(container.querySelector('.save-indicator--saved')).not.toBeNull();
        });

        // The FIRST write (lat, started earlier) settles LAST, with an error.
        // Being superseded, it must not override the indicator that the
        // newer (lng) write already reported as saved.
        resolveLatWrite(err({ message: 'boom' }));
        await Promise.resolve();
        await Promise.resolve();

        expect(container.querySelector('.save-indicator--error')).toBeNull();
        expect(container.querySelector('.save-indicator--saved')).not.toBeNull();

        dispose();
    });

    it('retry recomposes the placement from the current lat/lng draft, including a field edited after the failed write was issued', async () => {
        setCameras([camera()]);
        const { store, setPlacement } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));
        // Both the lat write AND its retry fail, so the retry affordance
        // (and its closure) stays put through the whole sequence below.
        setPlacement.mockResolvedValueOnce(err({ message: 'boom' })).mockResolvedValueOnce(err({ message: 'boom again' }));

        const container = document.createElement('div');
        document.body.append(container);
        const dispose = mount(container, { store, loggedIn: true });

        const inputs = container.querySelectorAll<HTMLInputElement>('.number-field-input');
        const latInput = inputs[0];
        const lngInput = inputs[1];
        if (!latInput || !lngInput) throw new Error('lat/lng inputs not found');

        // Edit lat -- this write fails and shows a retry affordance.
        latInput.focus();
        latInput.value = '68.72';
        latInput.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(500);
        await vi.waitFor(() => {
            expect(container.querySelector('.save-indicator--error')).not.toBeNull();
        });

        // Edit lng too, and let ITS write also fail -- both fields are now
        // reflected in the shared draft, and the retry shown is for lng's
        // (later, still-current) failure.
        lngInput.focus();
        lngInput.value = '15.9';
        lngInput.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(500);
        await vi.waitFor(() => {
            expect(container.querySelector('.save-indicator-retry')).not.toBeNull();
        });

        setPlacement.mockClear();
        setPlacement.mockResolvedValueOnce(ok({ lat: 68.72, lng: 15.9 }));
        container.querySelector<HTMLButtonElement>('.save-indicator-retry')?.click();
        await vi.advanceTimersByTimeAsync(0);

        // Retry must resend the full, current placement -- both the earlier
        // lat edit and the lng edit that triggered this specific failure.
        expect(setPlacement).toHaveBeenCalledWith('sigerfjord_01', { lat: 68.72, lng: 15.9 });

        dispose();
    });

    it('returns a live isPlaced property, not a value snapshotted at row creation', () => {
        const { store } = fakeStore(SettingsSchema.parse({}));
        const row = buildRow(camera(), null, { store, loggedIn: true, enabled: true });

        expect(row.isPlaced).toBe(false);

        row.update(camera(), { lat: 68.72, lng: 15.42 }, true, true);

        // A stale, snapshotted `isPlaced` (the pre-fix bug) would still read
        // `false` here even though `update()` just recorded a placement.
        expect(row.isPlaced).toBe(true);

        row.dispose();
        row.el.remove();
    });

    it('stops saying "uten plassering" once a placement arrives with the settings resource', () => {
        // The row is built before the placement is known (the settings
        // resource is still loading), so the label is corrected by
        // `update()` rather than by the initial render -- the path where a
        // stale label had nothing left to notify it.
        const { store } = fakeStore(SettingsSchema.parse({}));
        const row = buildRow(camera(), null, { store, loggedIn: true, enabled: true });

        const label = (): string => row.el.querySelector('.save-indicator')?.textContent.trim() ?? '';
        expect(label()).toBe('Uten plassering');

        row.update(camera(), { lat: 68.72, lng: 15.42 }, true, true);

        expect(row.el.querySelectorAll('.number-field-input')).toHaveLength(2);
        expect(label()).not.toBe('Uten plassering');

        row.dispose();
        row.el.remove();
    });

    it('renames the on-screen keyboard caption when the camera is renamed upstream', () => {
        const { store } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));
        const row = buildRow(camera(), { lat: 68.7, lng: 15.4 }, { store, loggedIn: true, enabled: true });

        const captions = (): string[] =>
            [...row.el.querySelectorAll<HTMLInputElement>('.number-field-input')].map((input) => input.dataset.keyboardContext ?? '');
        const before = captions();
        // Asserted, not assumed: an empty list would make both loops below
        // pass without checking a single caption.
        expect(before).toHaveLength(2);
        for (const caption of before) expect(caption).toContain('Sigerfjord');

        row.update(camera({ name: 'Sigerfjord kai' }), { lat: 68.7, lng: 15.4 }, true, true);

        // The caption is written once when the fields are built, so a name
        // arriving later from the cameras resource has to be pushed into
        // the existing inputs -- otherwise the keyboard tray keeps naming
        // the camera that no longer exists under that name.
        const after = captions();
        expect(after).toHaveLength(2);
        for (const caption of after) expect(caption).toContain('Sigerfjord kai');

        row.dispose();
        row.el.remove();
    });

    it('renders lat/lng disabled and the remove button disabled when logged out', () => {
        setCameras([camera()]);
        const { store } = fakeStore(SettingsSchema.parse({ placements: { sigerfjord_01: { lat: 68.7, lng: 15.4 } } }));
        const container = document.createElement('div');
        const dispose = mount(container, { store, loggedIn: false });

        expect(container.querySelector<HTMLInputElement>('.number-field-input')?.disabled).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('.camera-row-remove')?.disabled).toBe(true);

        dispose();
    });
});
