import { describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { signal } from '../../core/signal.js';
import { addMapLocateControl, type LocateState } from './locateControl.js';

/** Same fake Leaflet as `basemapControl.test.ts` -- see its doc comment for why the real one is not used here. */
function createFakeLeaflet(root: HTMLElement): typeof Leaflet {
    class FakeControl {
        container: HTMLElement | undefined;
        onAdd(): HTMLElement {
            throw new Error('overridden by extend()');
        }
        addTo(): this {
            this.container = this.onAdd();
            root.append(this.container);
            return this;
        }
        remove(): this {
            this.container?.remove();
            this.container = undefined;
            return this;
        }
    }

    const L = {
        Control: {
            extend(proto: { onAdd: () => HTMLElement }) {
                return class extends FakeControl {
                    override onAdd = proto.onAdd;
                };
            },
        },
        DomUtil: {
            create(tag: string, className?: string, container?: HTMLElement): HTMLElement {
                const element = document.createElement(tag);
                if (className !== undefined) element.className = className;
                container?.append(element);
                return element;
            },
        },
        DomEvent: {
            disableClickPropagation: vi.fn(),
            on(element: HTMLElement, type: string, handler: (event: Event) => void) {
                element.addEventListener(type, handler);
                return L.DomEvent;
            },
            preventDefault(event: Event) {
                event.preventDefault();
                return L.DomEvent;
            },
        },
    };
    return L as unknown as typeof Leaflet;
}

const LABELS: Record<LocateState, string> = {
    idle: 'Vis min posisjon',
    locating: 'Finner posisjonen din',
    located: 'Kartet står på din posisjon',
    denied: 'Posisjon avslått',
    unavailable: 'Fant ingen posisjon',
};

function mount(state = signal<LocateState>('idle'), onLocate = vi.fn()) {
    const root = document.createElement('div');
    document.body.append(root);
    const L = createFakeLeaflet(root);
    const dispose = addMapLocateControl(L, {} as unknown as Leaflet.Map, {
        state: () => state.get(),
        labelFor: (current) => LABELS[current],
        messageFor: (current) => (current === 'denied' || current === 'unavailable' ? LABELS[current] : null),
        onLocate,
    });
    return { root, state, onLocate, dispose };
}

describe('addMapLocateControl', () => {
    it('renders a button into the leaflet-bar stack', () => {
        const { root, dispose } = mount();

        expect(root.querySelector('.leaflet-bar.map-locate-control')).not.toBeNull();
        expect(root.querySelector('a.map-locate-button')?.getAttribute('role')).toBe('button');

        dispose();
    });

    it('labels itself for the current state', () => {
        const { root, dispose } = mount();

        const button = root.querySelector<HTMLAnchorElement>('.map-locate-button');
        expect(button?.title).toBe('Vis min posisjon');
        expect(button?.getAttribute('aria-label')).toBe('Vis min posisjon');

        dispose();
    });

    it('reports a press', () => {
        const { root, onLocate, dispose } = mount();

        root.querySelector<HTMLAnchorElement>('.map-locate-button')?.click();

        expect(onLocate).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('activates on Space too, without scrolling the page under the map', () => {
        const { root, onLocate, dispose } = mount();
        const button = root.querySelector<HTMLAnchorElement>('.map-locate-button');

        const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
        button?.dispatchEvent(event);

        expect(onLocate).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        dispose();
    });

    it('ignores other keys', () => {
        const { root, onLocate, dispose } = mount();

        root.querySelector<HTMLAnchorElement>('.map-locate-button')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

        expect(onLocate).not.toHaveBeenCalled();
        dispose();
    });

    it('announces that it is working, for a visitor who cannot see the pulse', () => {
        const state = signal<LocateState>('idle');
        const { root, dispose } = mount(state);

        state.set('locating');

        const button = root.querySelector<HTMLAnchorElement>('.map-locate-button');
        expect(button?.getAttribute('aria-busy')).toBe('true');
        expect(button?.classList.contains('map-locate-button--busy')).toBe(true);

        dispose();
    });

    it('explains a failure rather than leaving the button looking inert', () => {
        const state = signal<LocateState>('idle');
        const { root, dispose } = mount(state);

        state.set('denied');

        const message = root.querySelector<HTMLElement>('.map-locate-message');
        expect(message?.hidden).toBe(false);
        expect(message?.textContent).toBe('Posisjon avslått');

        dispose();
    });

    it('says nothing for a state that needs no explanation', () => {
        const state = signal<LocateState>('denied');
        const { root, dispose } = mount(state);

        state.set('located');

        expect(root.querySelector<HTMLElement>('.map-locate-message')?.hidden).toBe(true);
        dispose();
    });

    it('never disables itself, so a permission granted a moment later can still be used', () => {
        const state = signal<LocateState>('idle');
        const { root, onLocate, dispose } = mount(state);

        state.set('denied');
        root.querySelector<HTMLAnchorElement>('.map-locate-button')?.click();

        expect(onLocate).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('swaps rather than stacks its icon across renders', () => {
        const state = signal<LocateState>('idle');
        const { root, dispose } = mount(state);

        state.set('locating');
        state.set('located');

        expect(root.querySelectorAll('.map-locate-button svg')).toHaveLength(1);
        dispose();
    });

    it('removes the control and stops tracking when disposed', () => {
        const state = signal<LocateState>('idle');
        const { root, dispose } = mount(state);

        dispose();
        state.set('denied');

        expect(root.querySelector('.map-locate-control')).toBeNull();
    });
});
