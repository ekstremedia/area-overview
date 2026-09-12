/**
 * The basemap button, directly under the reset control: one press moves
 * to the next basemap in `BASEMAP_CYCLE` (dark, standard, satellite, and
 * round again).
 *
 * A cycling button rather than a menu because there are three options and
 * a kiosk has no hover: a popover would need its own dismiss handling,
 * its own tap targets and its own z-index fight with Leaflet's controls,
 * to save one press. The icon shows what the *next* press gives, not the
 * current basemap -- which one is showing is already obvious from the
 * whole map underneath it, so the button's job is to say where it goes.
 *
 * Same `L.Control` treatment (and the same reason) as `resetControl.ts`.
 */
import type * as Leaflet from 'leaflet';
import { effect } from '../../core/signal.js';
import { nextBasemap, type Basemap } from './tiles.js';

export interface MapBasemapControlOptions {
    /**
     * The basemap currently drawn, read fresh on every render -- a
     * function, not a value, so this control re-renders reactively when
     * the theme, the night schedule or the device's own choice changes it
     * (any signal read in here is tracked).
     */
    current: () => Basemap;
    /** Accessible label and tooltip for the button as it stands, given the basemap it would switch to. Passed in so this file needs no i18n import. */
    labelFor: (next: Basemap) => string;
    /** Called with the basemap the visitor just asked for. */
    onSelect: (next: Basemap) => void;
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

/** A crescent: the dark basemap. */
function moonIcon(): SVGSVGElement {
    const svg = svgRoot();
    svg.append(element('path', { d: 'M20.5 14.8A8.8 8.8 0 0 1 9.2 3.5a8.8 8.8 0 1 0 11.3 11.3Z' }));
    return svg;
}

/** A sun: the standard, light basemap -- the same pairing the theme setting already uses. */
function sunIcon(): SVGSVGElement {
    const svg = svgRoot();
    svg.append(element('circle', { cx: '12', cy: '12', r: '4' }));
    const rays: [string, string, string, string][] = [
        ['12', '2', '12', '4.5'],
        ['12', '19.5', '12', '22'],
        ['2', '12', '4.5', '12'],
        ['19.5', '12', '22', '12'],
        ['4.9', '4.9', '6.7', '6.7'],
        ['17.3', '17.3', '19.1', '19.1'],
        ['4.9', '19.1', '6.7', '17.3'],
        ['17.3', '6.7', '19.1', '4.9'],
    ];
    for (const [x1, y1, x2, y2] of rays) svg.append(element('line', { x1, y1, x2, y2 }));
    return svg;
}

/** A globe with a meridian: aerial imagery, and distinct in silhouette from the crosshair above it. */
function globeIcon(): SVGSVGElement {
    const svg = svgRoot();
    svg.append(element('circle', { cx: '12', cy: '12', r: '9' }));
    svg.append(element('line', { x1: '3', y1: '12', x2: '21', y2: '12' }));
    svg.append(element('ellipse', { cx: '12', cy: '12', rx: '4', ry: '9' }));
    return svg;
}

const ICONS: Record<Basemap, () => SVGSVGElement> = {
    dark: moonIcon,
    light: sunIcon,
    satellite: globeIcon,
};

/** Adds the control to `map` and returns a disposer that removes it (and its reactive effect) again. */
export function addMapBasemapControl(L: typeof Leaflet, map: Leaflet.Map, options: MapBasemapControlOptions): () => void {
    // Set by `onAdd`, which Leaflet calls synchronously from `addTo`
    // below -- so the effect started afterwards always finds them.
    let button: HTMLAnchorElement | undefined;
    // The basemap the button currently offers. Read by the click handler
    // instead of recomputing `nextBasemap(options.current())` there, so
    // what a press does is exactly what the icon on it says, even if a
    // theme change landed between the render and the press.
    let offered: Basemap = nextBasemap(options.current());

    const BasemapControl = L.Control.extend({
        options: { position: 'topleft' as const },
        onAdd(): HTMLElement {
            const container = L.DomUtil.create('div', 'leaflet-bar map-basemap-control');
            button = L.DomUtil.create('a', 'map-basemap-button', container);
            button.href = '#';
            button.setAttribute('role', 'button');

            // Without both of these a tap on the button also pans the map
            // underneath it, and the `href="#"` would rewrite the route.
            L.DomEvent.disableClickPropagation(button);
            L.DomEvent.on(button, 'click', (event) => {
                L.DomEvent.preventDefault(event);
                options.onSelect(offered);
            });
            // An anchor carrying `role="button"` activates on Enter by
            // itself (the browser fires a click) but not on Space, which
            // a real `<button>` would take -- so a keyboard visitor
            // pressing the key the role promises would scroll the page
            // instead of switching the basemap. Handled here rather than
            // by using a `<button>`: Leaflet's own `.leaflet-bar` chrome
            // (and the zoom controls this sits under) is anchor-shaped,
            // and a lone button in that stack would need its own reset of
            // every border, background and focus style to match.
            L.DomEvent.on(button, 'keydown', (event) => {
                if (!(event instanceof KeyboardEvent) || event.key !== ' ') return;
                L.DomEvent.preventDefault(event); // ...or the page scrolls under the map as well
                options.onSelect(offered);
            });
            return container;
        },
    });

    const control = new BasemapControl();
    control.addTo(map);

    const disposeEffect = effect(() => {
        offered = nextBasemap(options.current());
        if (!button) return;
        const label = options.labelFor(offered);
        button.title = label;
        button.setAttribute('aria-label', label);
        button.replaceChildren(ICONS[offered]());
    });

    return function dispose(): void {
        disposeEffect();
        control.remove();
        button = undefined;
    };
}
