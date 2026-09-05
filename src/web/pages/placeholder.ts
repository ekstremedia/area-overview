/**
 * Phase 5 placeholder page body: route name + locality caption, both via
 * `t()`, and nothing else -- real page content arrives Phase 6+. The
 * returned `render` matches the contract `AppShell.ts` expects from every
 * page module: mount into `container`, return a disposer that tears down
 * everything this page started (here: two `effect()`s, nothing else).
 */
import { effect } from '../core/signal.js';
import { t, type ParamlessKey } from '../i18n/index.js';

export function createPlaceholderPage(titleKey: ParamlessKey, localityKey: ParamlessKey): (container: HTMLElement) => () => void {
    return function render(container: HTMLElement): () => void {
        const title = document.createElement('h1');
        title.className = 'page-placeholder-title';
        const locality = document.createElement('p');
        locality.className = 'page-placeholder-locality';
        const body = document.createElement('p');
        body.className = 'page-placeholder-body';

        container.append(title, locality, body);

        const disposeTitle = effect(() => {
            title.textContent = t(titleKey);
        });
        const disposeLocality = effect(() => {
            locality.textContent = t(localityKey);
        });
        const disposeBody = effect(() => {
            body.textContent = t('page.placeholderBody');
        });

        return function dispose(): void {
            disposeTitle();
            disposeLocality();
            disposeBody();
            title.remove();
            locality.remove();
            body.remove();
        };
    };
}
