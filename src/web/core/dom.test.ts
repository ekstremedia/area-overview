import { describe, expect, it, vi } from 'vitest';
import { signal } from './signal.js';
import { bind, h } from './dom.js';

describe('h', () => {
    it('creates an element with attributes, className and text children', () => {
        const el = h('div', { className: 'card', 'data-id': '42' }, 'hello ', 'world');

        expect(el.tagName).toBe('DIV');
        expect(el.className).toBe('card');
        expect(el.getAttribute('data-id')).toBe('42');
        expect(el.textContent).toBe('hello world');
    });

    it('wires an onClick-style prop as a real event listener', () => {
        const onClick = vi.fn();
        const el = h('button', { onClick });

        el.dispatchEvent(new Event('click'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('appends Node children as-is', () => {
        const child = h('span', {}, 'inner');
        const parent = h('div', {}, child);

        expect(parent.firstElementChild).toBe(child);
    });
});

describe('bind', () => {
    it('runs fn immediately and again whenever the signal changes', () => {
        const label = signal('a');
        const el = h('span');
        const seen: string[] = [];

        bind(el, label, (value) => seen.push(value));
        expect(seen).toEqual(['a']);

        label.set('b');
        expect(seen).toEqual(['a', 'b']);
    });

    it('disposes the underlying effect, stopping further updates', () => {
        const label = signal('a');
        const el = h('span');
        const seen: string[] = [];

        const dispose = bind(el, label, (value) => seen.push(value));
        dispose();

        label.set('b');
        expect(seen).toEqual(['a']);
    });
});
