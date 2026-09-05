import { describe, expect, it, vi } from 'vitest';
import { selectField } from './SelectField.js';

const OPTIONS = [
    { value: 'dim', label: 'Dempet' },
    { value: 'dark', label: 'Mørk' },
    { value: 'off', label: 'Av' },
] as const;

describe('selectField', () => {
    it('renders a tile per option, marking the active one', () => {
        const handle = selectField({ value: 'dark', options: OPTIONS, onChange: vi.fn() });

        const tiles = [...handle.el.querySelectorAll<HTMLButtonElement>('.select-field-tile')];
        expect(tiles.map((tile) => tile.textContent)).toEqual(['Dempet', 'Mørk', 'Av']);
        expect(tiles[1]?.classList.contains('select-field-tile--active')).toBe(true);
        expect(tiles[0]?.classList.contains('select-field-tile--active')).toBe(false);
    });

    it('calls onChange immediately on tap, and does not call it when tapping the already-active tile', () => {
        const onChange = vi.fn();
        const handle = selectField({ value: 'dim', options: OPTIONS, onChange });

        const tiles = [...handle.el.querySelectorAll<HTMLButtonElement>('.select-field-tile')];
        tiles[0]?.click(); // already active
        expect(onChange).not.toHaveBeenCalled();

        tiles[2]?.click();
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('off');
    });

    it('setState updates the active tile without recreating elements', () => {
        const handle = selectField({ value: 'dim', options: OPTIONS, onChange: vi.fn() });
        const tiles = [...handle.el.querySelectorAll<HTMLButtonElement>('.select-field-tile')];

        handle.setState('off');

        expect(tiles[2]?.classList.contains('select-field-tile--active')).toBe(true);
        expect([...handle.el.querySelectorAll('.select-field-tile')]).toEqual(tiles);
    });
});
