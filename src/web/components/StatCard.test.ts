import { describe, expect, it } from 'vitest';
import { statCard } from './StatCard.js';

describe('statCard', () => {
    it('renders a label, value and unit', () => {
        const el = statCard({ label: 'Vind', value: '6,2', unit: 'm/s', size: 'md' });

        expect(el.classList.contains('stat-card')).toBe(true);
        expect(el.classList.contains('stat-card--md')).toBe(true);
        expect(el.querySelector('.stat-card-label')?.textContent).toBe('Vind');
        expect(el.querySelector('.stat-card-value')?.textContent).toBe('6,2 m/s');
        expect(el.querySelector('.stat-card-unit')?.textContent).toBe(' m/s');
    });

    it('omits the label element entirely when no label is given (tide sea-state inline figures)', () => {
        const el = statCard({ value: '9,2', unit: '°C sjø', size: 'sm' });

        expect(el.querySelector('.stat-card-label')).toBeNull();
        expect(el.querySelector('.stat-card-value')?.textContent).toBe('9,2 °C sjø');
    });

    it('renders a bare value with no unit at all', () => {
        const el = statCard({ label: 'Kp', value: '5', size: 'lg' });

        expect(el.querySelector('.stat-card-unit')).toBeNull();
        expect(el.querySelector('.stat-card-value')?.textContent).toBe('5');
    });
});
