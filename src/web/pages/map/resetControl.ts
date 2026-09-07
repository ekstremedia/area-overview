/**
 * A "back to the home view" button, sitting directly under Leaflet's own
 * zoom controls.
 *
 * A wall display gets panned and zoomed by whoever walks past it, and
 * short of waiting out the idle-reset there was no way to put it back.
 * The idle reset already applies `settings.homeView` (see `homeView.ts`);
 * this is the same action on demand.
 *
 * Built as a real `L.Control` rather than a floating `<button>` over the
 * map so Leaflet positions it in the same stack as the zoom buttons and
 * handles the click-through/drag suppression that a bare overlay would
 * have to reimplement.
 */
import type * as Leaflet from 'leaflet';

export interface MapResetControlOptions {
    /** Accessible label and tooltip -- passed in so this file needs no i18n import. */
    label: string;
    onReset: () => void;
}

/** A crosshair-on-a-dot: "put the view back where it points", distinct from the +/- glyphs above it. */
function homeIcon(): SVGSVGElement {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '5');
    svg.append(circle);

    const dot = document.createElementNS(svgNs, 'circle');
    dot.setAttribute('cx', '12');
    dot.setAttribute('cy', '12');
    dot.setAttribute('r', '1.6');
    dot.setAttribute('fill', 'currentColor');
    dot.setAttribute('stroke', 'none');
    svg.append(dot);

    const ticks: [string, string, string, string][] = [
        ['12', '1.5', '12', '4.5'],
        ['12', '19.5', '12', '22.5'],
        ['1.5', '12', '4.5', '12'],
        ['19.5', '12', '22.5', '12'],
    ];
    for (const [x1, y1, x2, y2] of ticks) {
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        svg.append(line);
    }
    return svg;
}

/** Adds the control to `map` and returns a disposer that removes it again. */
export function addMapResetControl(L: typeof Leaflet, map: Leaflet.Map, options: MapResetControlOptions): () => void {
    const ResetControl = L.Control.extend({
        options: { position: 'topleft' as const },
        onAdd(): HTMLElement {
            const container = L.DomUtil.create('div', 'leaflet-bar map-reset-control');
            const button = L.DomUtil.create('a', 'map-reset-button', container);
            button.href = '#';
            button.setAttribute('role', 'button');
            button.title = options.label;
            button.setAttribute('aria-label', options.label);
            button.append(homeIcon());

            // Without both of these a tap on the button also pans the map
            // underneath it, and the `href="#"` would rewrite the route.
            L.DomEvent.disableClickPropagation(button);
            L.DomEvent.on(button, 'click', (event) => {
                L.DomEvent.preventDefault(event);
                options.onReset();
            });
            return container;
        },
    });

    const control = new ResetControl();
    control.addTo(map);

    return function dispose(): void {
        control.remove();
    };
}
