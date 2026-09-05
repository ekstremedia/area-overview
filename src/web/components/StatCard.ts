/**
 * A labeled stat display: an optional small-caps label above, a numeral,
 * and an optional muted unit suffix on the same line as the numeral. Used
 * across three artboards that are all the same underlying pattern at
 * different sizes -- the weather page's 2x2 stat grid (40px numerals, a
 * label above each), the aurora page's bottom-of-column stats (44px,
 * likewise labeled), and the tide page's sea-state figures (30px, no
 * label -- just numeral + unit inline, per artboard 04's "9,2 °C sjø").
 *
 * A pure DOM builder, not reactive itself: callers rebuild/replace it on
 * every poll, same as every other page fragment in this app.
 */
export type StatCardSize = 'sm' | 'md' | 'lg';

export interface StatCardOptions {
    /** Small-caps caption above the numeral. Omitted entirely (no empty label element) for the tide page's inline sea-state figures, which have no label line in the artboard. */
    label?: string;
    /** The numeral, already locale-formatted (e.g. via `formatNumber`) -- this component never formats numbers itself. */
    value: string;
    /** A muted suffix rendered smaller, inline with the numeral (e.g. "m/s", "°C sjø"). */
    unit?: string;
    size: StatCardSize;
}

export function statCard(options: StatCardOptions): HTMLElement {
    const root = document.createElement('div');
    root.className = `stat-card stat-card--${options.size}`;

    if (options.label !== undefined) {
        const label = document.createElement('div');
        label.className = 'stat-card-label';
        label.textContent = options.label;
        root.append(label);
    }

    const value = document.createElement('div');
    value.className = 'stat-card-value';
    value.append(document.createTextNode(options.value));

    if (options.unit !== undefined) {
        const unit = document.createElement('span');
        unit.className = 'stat-card-unit';
        unit.textContent = ` ${options.unit}`;
        value.append(unit);
    }

    root.append(value);
    return root;
}
