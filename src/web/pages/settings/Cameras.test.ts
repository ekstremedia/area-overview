import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '../../../shared/result.js';
import type { Camera, CameraListResponse } from '../../../shared/schemas/camera.js';
import { SettingsSchema, type Settings } from '../../../shared/schemas/settings.js';
import { signal } from '../../core/signal.js';
import type { ResourceState } from '../../core/resource.js';
import type { SettingsStore } from '../../settings/sharedStore.js';

const camerasState = signal<ResourceState<CameraListResponse>>({ status: 'idle' });
vi.mock('../../camera-resource.js', () => ({ camerasResource: { state: camerasState } }));

const { mount } = await import('./Cameras.js');

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
    const store: SettingsStore = { settings, patchSettings: vi.fn(), setPlacement, dispose: vi.fn() };
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
        expect(row?.querySelector('.camera-row-unplaced')?.textContent).toBe('Uten plassering');
        expect(row?.querySelectorAll('.number-field-input')).toHaveLength(0);

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
