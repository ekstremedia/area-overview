/**
 * Renders an `AutosaveStatus` (see `src/web/settings/autosave.ts`) as the
 * small-caps text described in the phase notes: nothing for idle (unless
 * the caller supplies a persistent `idleLabel`, e.g. the cameras section's
 * "Lagret"/"Uten plassering" placement-status text), "Lagrer…"/"Saving…"
 * while a debounce is pending or a write is in flight, "Lagret"/"Saved"
 * for ~1.5s after a successful write, or the error text plus a retry
 * affordance that never auto-clears.
 *
 * A pure DOM builder, not reactive itself -- callers wrap it in a `bind()`/
 * `effect()` that replaces the node whenever `status` changes, same as
 * every other small indicator in this app (`ErrorBand`, `ImageWithAge`'s
 * age badge).
 */
import type { AutosaveStatus } from '../settings/autosave.js';
import { t } from '../i18n/index.js';

export interface SaveIndicatorOptions {
    status: AutosaveStatus;
    /** Shown for `{kind:'idle'}` only -- e.g. a persistent placement-status label. Omitted renders nothing for idle. */
    idleLabel?: string;
}

export function saveIndicator(options: SaveIndicatorOptions): HTMLElement {
    const root = document.createElement('div');
    root.className = 'save-indicator';
    const { status } = options;

    switch (status.kind) {
        case 'idle':
            root.classList.add('save-indicator--idle');
            root.textContent = options.idleLabel ?? '';
            break;
        case 'pending':
            root.classList.add('save-indicator--pending');
            root.textContent = t('settings.status.pending');
            break;
        case 'saving':
            root.classList.add('save-indicator--pending');
            root.textContent = t('settings.status.saving');
            break;
        case 'saved':
            root.classList.add('save-indicator--saved');
            root.textContent = t('settings.status.saved');
            break;
        case 'error': {
            root.classList.add('save-indicator--error');
            const message = document.createElement('span');
            message.className = 'save-indicator-message';
            message.textContent = t('settings.status.error');
            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.className = 'save-indicator-retry';
            retryButton.textContent = t('settings.status.retry');
            const onRetry = status.retry;
            retryButton.addEventListener('click', () => {
                onRetry();
            });
            root.append(message, retryButton);
            break;
        }
    }

    return root;
}
