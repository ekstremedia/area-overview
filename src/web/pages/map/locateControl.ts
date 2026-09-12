/**
 * The locate button, fourth in the `topleft` stack: zoom, reset, basemap,
 * locate. One press moves the map to where the visitor actually is.
 *
 * Same `L.Control` treatment, and the same reasons, as `resetControl.ts`
 * and `basemapControl.ts` -- see the latter's doc comment. The icon is a
 * map pin, distinct in silhouette from the crosshair two above it and the
 * globe directly above.
 *
 * It never disables itself, in any state. A refused permission can be
 * granted a moment later from the browser's own UI, and a fix that was
 * unavailable indoors may be available by the window, so a second press
 * is always worth allowing -- a button that greys itself out after one
 * failure would be lying about whether retrying can work.
 */
import type * as Leaflet from 'leaflet';
import { effect } from '../../core/signal.js';

/**
 * `locating` is the only transient state. The three failures persist
 * until the next press, so the button can explain itself rather than
 * flicking back to idle and leaving nothing behind.
 */
export type LocateState = 'idle' | 'locating' | 'located' | 'denied' | 'unavailable';

export interface MapLocateControlOptions {
    /** The control's current state, read fresh on every render -- a function, not a value, so this re-renders reactively (any signal read in here is tracked). */
    state: () => LocateState;
    /** Accessible label and tooltip for the button as it stands. Passed in so this file needs no i18n import. */
    labelFor: (state: LocateState) => string;
    /** The line shown under the control for a state worth explaining, or `null` for one that isn't. */
    messageFor: (state: LocateState) => string | null;
    onLocate: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgRoot(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
}

function element(name: string, attributes: Record<string, string>): SVGElement {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
}

/** A map pin: teardrop outline plus its hole. */
function pinIcon(): SVGSVGElement {
    const svg = svgRoot();
    svg.append(element('path', { d: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z' }));
    svg.append(element('circle', { cx: '12', cy: '10', r: '2.5' }));
    return svg;
}

export function addMapLocateControl(L: typeof Leaflet, map: Leaflet.Map, options: MapLocateControlOptions): () => void {
    // Set by `onAdd`, which Leaflet calls synchronously from `addTo`
    // below -- so the effect started afterwards always finds them.
    let button: HTMLAnchorElement | undefined;
    let message: HTMLDivElement | undefined;

    const LocateControl = L.Control.extend({
        options: { position: 'topleft' as const },
        onAdd(): HTMLElement {
            const container = L.DomUtil.create('div', 'leaflet-bar map-locate-control');
            button = L.DomUtil.create('a', 'map-locate-button', container);
            button.href = '#';
            button.setAttribute('role', 'button');

            message = L.DomUtil.create('div', 'map-locate-message', container);
            message.hidden = true;

            // Without both of these a tap on the button also pans the map
            // underneath it, and the `href="#"` would rewrite the route.
            L.DomEvent.disableClickPropagation(container);
            L.DomEvent.on(button, 'click', (event) => {
                L.DomEvent.preventDefault(event);
                options.onLocate();
            });
            // An anchor carrying `role="button"` activates on Enter by
            // itself but not on Space -- see `basemapControl.ts` for the
            // full reasoning, including why this stays an anchor.
            L.DomEvent.on(button, 'keydown', (event) => {
                if (!(event instanceof KeyboardEvent) || event.key !== ' ') return;
                L.DomEvent.preventDefault(event); // ...or the page scrolls under the map as well
                options.onLocate();
            });
            return container;
        },
    });

    const control = new LocateControl();
    control.addTo(map);

    const disposeEffect = effect(() => {
        const state = options.state();
        if (!button || !message) return;

        const label = options.labelFor(state);
        button.title = label;
        button.setAttribute('aria-label', label);
        // Announced rather than merely styled: a visitor who cannot see
        // the pulse still learns the press was received.
        button.setAttribute('aria-busy', state === 'locating' ? 'true' : 'false');
        button.classList.toggle('map-locate-button--busy', state === 'locating');

        const text = options.messageFor(state);
        message.textContent = text ?? '';
        message.hidden = text === null;
        button.replaceChildren(pinIcon());
    });

    return function dispose(): void {
        disposeEffect();
        control.remove();
        button = undefined;
        message = undefined;
    };
}
