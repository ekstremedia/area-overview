/**
 * Minimal, non-reactive DOM construction helpers. No virtual DOM, no
 * diffing: `h` creates real nodes directly, and `bind` is the only bridge
 * back into reactivity -- it wires an `effect` that re-runs a plain DOM
 * mutation whenever a signal changes.
 */
import { effect, type ReadonlySignal } from './signal.js';

export type HProps = Record<string, unknown>;

export function h(tag: string, props: HProps = {}, ...children: (string | Node)[]): HTMLElement {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (key === 'className' && typeof value === 'string') {
            el.className = value;
        } else if (typeof value === 'string') {
            el.setAttribute(key, value);
        } else if (typeof value === 'boolean') {
            if (value) el.setAttribute(key, '');
        }
    }
    for (const child of children) {
        el.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
}

export function bind<T>(el: Node, source: ReadonlySignal<T>, fn: (value: T, el: Node) => void): () => void {
    return effect(() => {
        fn(source.get(), el);
    });
}
