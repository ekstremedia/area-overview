/**
 * The kiosk's on-screen keyboard (artboards 07/08): a dark tray docked at
 * the bottom of the viewport, shown the moment any eligible text input on
 * the settings page (or its login dialog) gains focus, hidden on blur or
 * via its own "Skjul ▾"/"Hide ▾" button. Wraps `simple-keyboard`.
 *
 * Two things this module is deliberately careful about:
 *
 *  - Lazy loading. `simple-keyboard` (and the layout package) are only
 *    ever `import()`ed on the *first* focus event this instance sees --
 *    never eagerly on mount, never in the initial bundle. `loadKeyboard`/
 *    `loadNorwegianLayout`/`loadEnglishLayout` are injectable (defaulting
 *    to real dynamic imports) specifically so a test can assert the real
 *    module was never touched before that first focus, without fighting
 *    Vitest's dynamic-import interception.
 *
 *  - Real DOM events. `simple-keyboard`'s `onChange` hands back the whole
 *    new input string; this module writes it straight into the actual
 *    focused `<input>`'s `.value` and dispatches a real `input` event
 *    (`{bubbles:true}`) on it -- so `NumberField`/`TimeField`'s own
 *    `input`-event listeners (validation, autosave `trigger()`) see a
 *    virtual keystroke exactly as they'd see a physical one. A virtual
 *    "Enter" dispatches a synthetic `keydown` Enter for the same reason
 *    (those components' own Enter-flushes-immediately handling already
 *    listens for exactly that).
 *
 * Layout: `inputmode="decimal"` gets the numeric keypad; every other
 * eligible input gets the Norwegian or English full layout, following
 * `currentLanguage` reactively (swapped live via `setOptions` if the
 * language changes while the keyboard is open).
 */
import { effect } from '../core/signal.js';
import { currentLanguage, t } from '../i18n/index.js';
import './OnScreenKeyboard.css';

interface KeyboardLayoutShape {
    layout: { default: string[]; shift?: string[] };
}

interface KeyboardOptionsLike {
    onChange?: (input: string) => void;
    onKeyPress?: (button: string) => void;
    layout?: { default: string[]; shift?: string[] };
    layoutName?: string;
    display?: Record<string, string>;
    theme?: string;
    physicalKeyboardHighlight?: boolean;
    preventMouseDownDefault?: boolean;
}

interface KeyboardInstanceLike {
    setOptions: (options: KeyboardOptionsLike) => void;
    setInput: (input: string) => void;
    destroy: () => void;
}

type KeyboardConstructorLike = new (container: HTMLDivElement, options: KeyboardOptionsLike) => KeyboardInstanceLike;

export interface OnScreenKeyboardLoaders {
    loadKeyboard?: () => Promise<{ default: KeyboardConstructorLike }>;
    loadNorwegianLayout?: () => Promise<{ default: KeyboardLayoutShape }>;
    loadEnglishLayout?: () => Promise<{ default: KeyboardLayoutShape }>;
}

async function defaultLoadKeyboard(): Promise<{ default: KeyboardConstructorLike }> {
    const mod = await import('simple-keyboard');
    return { default: mod.default as unknown as KeyboardConstructorLike };
}

async function defaultLoadNorwegianLayout(): Promise<{ default: KeyboardLayoutShape }> {
    const mod = await import('simple-keyboard-layouts/build/layouts/norwegian.js');
    return mod as unknown as { default: KeyboardLayoutShape };
}

async function defaultLoadEnglishLayout(): Promise<{ default: KeyboardLayoutShape }> {
    const mod = await import('simple-keyboard-layouts/build/layouts/english.js');
    return mod as unknown as { default: KeyboardLayoutShape };
}

/**
 * The artboard's numeric tray: one row of twelve, `,` as the decimal
 * separator, a backspace key. A single row keeps the digits in their
 * familiar left-to-right order and costs one row of height instead of
 * two, which is what the tray can afford over a 600px-tall screen.
 */
const NUMERIC_LAYOUT: KeyboardLayoutShape = {
    layout: { default: ['1 2 3 4 5 6 7 8 9 0 , {bksp}'] },
};

const HIDE_GRACE_MS = 150;

function isEligible(target: EventTarget | null): target is HTMLInputElement {
    return target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'password');
}

function backspaceLabel(language: 'nb' | 'en'): string {
    return language === 'nb' ? 'Slett' : 'Delete';
}

export interface OnScreenKeyboardHandle {
    dispose(): void;
}

export function mountOnScreenKeyboard(attachTo: HTMLElement = document.body, loaders: OnScreenKeyboardLoaders = {}): OnScreenKeyboardHandle {
    const loadKeyboard = loaders.loadKeyboard ?? defaultLoadKeyboard;
    const loadNorwegianLayout = loaders.loadNorwegianLayout ?? defaultLoadNorwegianLayout;
    const loadEnglishLayout = loaders.loadEnglishLayout ?? defaultLoadEnglishLayout;

    const tray = document.createElement('div');
    tray.className = 'keyboard-tray keyboard-tray--hidden';
    // `simple-keyboard` checks `preventMouseDownDefault` itself for its own
    // buttons; this catch-all additionally protects the caption/hide row.
    tray.addEventListener('mousedown', (event) => {
        event.preventDefault();
    });

    const header = document.createElement('div');
    header.className = 'keyboard-tray-header';
    const caption = document.createElement('div');
    caption.className = 'keyboard-tray-caption';
    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'keyboard-tray-hide';
    header.append(caption, hideButton);

    const keyboardContainer = document.createElement('div');
    keyboardContainer.className = 'keyboard-tray-keys';

    tray.append(header, keyboardContainer);
    attachTo.append(tray);

    let focusedInput: HTMLInputElement | null = null;
    let instance: KeyboardInstanceLike | null = null;
    let instancePromise: Promise<KeyboardInstanceLike> | null = null;
    let currentLayoutKind: 'numeric' | 'text' | null = null;
    let currentLayoutLanguage: 'nb' | 'en' | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    // Read through a function, not the bare `disposed` variable, at every
    // check below: `disposed` can flip to `true` from `dispose()` while
    // `applyLayoutFor` is suspended on an `await`, and TS's control-flow
    // narrowing can't see that closure-based mutation across the `await`
    // boundary -- reading it directly makes the compiler (wrongly) treat a
    // later re-check as dead code (same issue documented in
    // `core/resource.ts`'s `isDisposed()` and `MapPage.ts`'s `isDisposed()`).
    function isDisposed(): boolean {
        return disposed;
    }

    function isVisible(): boolean {
        return !tray.classList.contains('keyboard-tray--hidden');
    }

    function show(): void {
        tray.classList.remove('keyboard-tray--hidden');
    }

    function hide(): void {
        tray.classList.add('keyboard-tray--hidden');
        focusedInput = null;
    }

    function cancelScheduledHide(): void {
        if (hideTimer !== undefined) {
            clearTimeout(hideTimer);
            hideTimer = undefined;
        }
    }

    function scheduleHide(): void {
        cancelScheduledHide();
        hideTimer = setTimeout(() => {
            hide();
        }, HIDE_GRACE_MS);
    }

    function layoutKindFor(input: HTMLInputElement): 'numeric' | 'text' {
        return input.inputMode === 'decimal' ? 'numeric' : 'text';
    }

    async function ensureInstance(): Promise<KeyboardInstanceLike> {
        instancePromise ??= (async () => {
            const { default: Keyboard } = await loadKeyboard();
            const built = new Keyboard(keyboardContainer, {
                theme: 'hg-theme-default area-keyboard',
                physicalKeyboardHighlight: false,
                preventMouseDownDefault: true,
                onChange: (input: string) => {
                    if (!focusedInput) return;
                    focusedInput.value = input;
                    focusedInput.dispatchEvent(new Event('input', { bubbles: true }));
                },
                onKeyPress: (button: string) => {
                    if (!focusedInput) return;
                    if (button === '{enter}') {
                        focusedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                        focusedInput.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                },
            });
            instance = built;
            return built;
        })();
        return instancePromise;
    }

    async function loadLayout(kind: 'numeric' | 'text'): Promise<KeyboardLayoutShape> {
        if (kind === 'numeric') return NUMERIC_LAYOUT;
        const language = currentLanguage.get();
        const { default: layout } = language === 'nb' ? await loadNorwegianLayout() : await loadEnglishLayout();
        return layout;
    }

    async function applyLayoutFor(input: HTMLInputElement): Promise<void> {
        const kind = layoutKindFor(input);
        const kb = await ensureInstance();
        if (isDisposed() || focusedInput !== input) return;

        const language = currentLanguage.get();
        // Which keyboard, and -- when the field says so via
        // `data-keyboard-context` -- what it is editing. On a tray that
        // covers half a kiosk screen, "Talltastatur" alone doesn't say
        // which of two identical-looking number fields has focus.
        const kindLabel = kind === 'numeric' ? t('keyboard.numericLabel') : t('keyboard.textLabel');
        const context = input.dataset.keyboardContext;
        caption.textContent =
            context === undefined || context === '' ? kindLabel : t('keyboard.captionWithField', { kind: kindLabel, field: context });

        // Reload the layout module when the *kind* changes (numeric <-> text),
        // or when it stays 'text' but the language changed underneath it --
        // a numeric layout is language-invariant, so a language change alone
        // never needs a reload while a decimal input is focused.
        const needsReload = currentLayoutKind !== kind || (kind === 'text' && currentLayoutLanguage !== language);
        if (needsReload) {
            const layout = await loadLayout(kind);
            if (isDisposed() || focusedInput !== input) return;
            kb.setOptions({ layout: layout.layout, display: { '{bksp}': backspaceLabel(language) } });
            currentLayoutKind = kind;
            currentLayoutLanguage = kind === 'text' ? language : currentLayoutLanguage;
        } else {
            kb.setOptions({ display: { '{bksp}': backspaceLabel(language) } });
        }
        kb.setInput(input.value);
    }

    function handleFocusIn(event: FocusEvent): void {
        const target = event.target;
        if (isEligible(target)) {
            cancelScheduledHide();
            focusedInput = target;
            show();
            void applyLayoutFor(target);
            return;
        }
        if (tray.contains(target as Node)) {
            cancelScheduledHide();
            return;
        }
        scheduleHide();
    }

    function handleFocusOut(event: FocusEvent): void {
        if (event.target !== focusedInput) return;
        const next = event.relatedTarget;
        if (next instanceof Node && tray.contains(next)) return; // moving into the tray itself
        scheduleHide();
    }

    hideButton.addEventListener('click', () => {
        hide();
    });

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    const disposeLanguageEffect = effect(() => {
        currentLanguage.get(); // re-render caption/backspace label reactively
        if (!isVisible() || !instance || !focusedInput) return;
        void applyLayoutFor(focusedInput);
    });

    const disposeHideLabelEffect = effect(() => {
        hideButton.textContent = t('keyboard.hide');
    });

    function dispose(): void {
        disposed = true;
        cancelScheduledHide();
        document.removeEventListener('focusin', handleFocusIn);
        document.removeEventListener('focusout', handleFocusOut);
        disposeLanguageEffect();
        disposeHideLabelEffect();
        instance?.destroy();
        tray.remove();
    }

    return { dispose };
}
