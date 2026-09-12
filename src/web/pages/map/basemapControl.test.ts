import { describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { signal } from '../../core/signal.js';
import { addMapBasemapControl } from './basemapControl.js';
import type { Basemap } from './tiles.js';

/**
 * Enough of `L.Control`/`L.DomUtil`/`L.DomEvent` for this control: the
 * real ones need a live map with a pane structure, and what is worth
 * proving here is the button's own behaviour -- what it offers, what a
 * press reports, and that both follow the basemap reactively.
 */
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

function setup(initial: Basemap = 'dark') {
    const root = document.createElement('div');
    document.body.append(root);
    const L = createFakeLeaflet(root);
    const current = signal<Basemap>(initial);
    const onSelect = vi.fn<(next: Basemap) => void>();

    const dispose = addMapBasemapControl(L, {} as Leaflet.Map, {
        current: () => current.get(),
        labelFor: (next) => `to:${next}`,
        onSelect,
    });

    function button(): HTMLAnchorElement {
        const element = root.querySelector<HTMLAnchorElement>('.map-basemap-button');
        if (!element) throw new Error('expected the basemap button to be in the DOM');
        return element;
    }

    return {
        root,
        current,
        onSelect,
        button,
        dispose: () => {
            dispose();
            root.remove();
        },
    };
}

describe('addMapBasemapControl', () => {
    it('offers the next basemap in the cycle, labelled and with an icon', () => {
        const { button, dispose } = setup('dark');

        expect(button().title).toBe('to:light');
        expect(button().getAttribute('aria-label')).toBe('to:light');
        expect(button().querySelector('svg')).not.toBeNull();

        dispose();
    });

    it('reports the basemap it was offering when pressed', () => {
        const { button, onSelect, dispose } = setup('satellite');

        button().click();

        expect(onSelect).toHaveBeenCalledWith('dark');
        dispose();
    });

    it('activates on Space, which its role="button" promises but an anchor does not give for free', () => {
        const { button, onSelect, dispose } = setup('dark');

        const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true, bubbles: true });
        button().dispatchEvent(event);

        expect(onSelect).toHaveBeenCalledWith('light');
        expect(event.defaultPrevented).toBe(true); // ...or the page scrolls as well
        dispose();
    });

    it('ignores other keys', () => {
        const { button, onSelect, dispose } = setup('dark');

        button().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', cancelable: true, bubbles: true }));
        button().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true, bubbles: true }));

        expect(onSelect).not.toHaveBeenCalled();
        dispose();
    });

    it('re-renders when the basemap changes underneath it (a theme or night-schedule switch)', () => {
        const { button, current, onSelect, dispose } = setup('dark');

        current.set('light');

        expect(button().title).toBe('to:satellite');
        button().click();
        expect(onSelect).toHaveBeenCalledWith('satellite');

        dispose();
    });

    it('swaps the icon rather than stacking a second one on every render', () => {
        const { button, current, dispose } = setup('dark');

        current.set('light');
        current.set('satellite');

        expect(button().querySelectorAll('svg')).toHaveLength(1);
        dispose();
    });

    it('removes the control and stops tracking on dispose', () => {
        const { root, current, dispose } = setup('dark');

        dispose();
        current.set('satellite'); // must not throw against the removed button

        expect(root.querySelector('.map-basemap-button')).toBeNull();
    });
});
