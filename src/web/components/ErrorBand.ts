/**
 * A visible error/stale-data indicator for a page whose `resource()` is
 * currently in its `error` state. Renders sensibly in both of that
 * state's shapes: stale data plus a warning (`lastData` present -- the
 * page still shows what it has, this band just says it's not current),
 * or no data at all plus a reason (no `lastData` -- nothing else to show
 * on the page).
 */
import { t } from '../i18n/index.js';

export interface ErrorBandOptions {
    /** Whether the resource still has a last-known-good value to fall back to. */
    hasStaleData: boolean;
}

export function errorBand(options: ErrorBandOptions): HTMLElement {
    const root = document.createElement('div');
    root.className = 'error-band';
    root.textContent = options.hasStaleData ? t('error.staleData') : t('error.noData');
    return root;
}
