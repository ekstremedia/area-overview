import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../core/signal.js';
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { mountOnScreenKeyboard } = await import('./OnScreenKeyboard.js');

interface FakeKeyboardOptions {
    onChange?: (input: string) => void;
    onKeyPress?: (button: string) => void;
    layout?: { default: string[] };
    display?: Record<string, string>;
}

class FakeKeyboard {
    options: FakeKeyboardOptions;
    static instances: FakeKeyboard[] = [];
    static setOptionsCalls: FakeKeyboardOptions[] = [];
    destroyed = false;

    constructor(
        public container: HTMLElement,
        options: FakeKeyboardOptions,
    ) {
        this.options = options;
        FakeKeyboard.instances.push(this);
    }

    setOptions(next: FakeKeyboardOptions): void {
        this.options = { ...this.options, ...next };
        FakeKeyboard.setOptionsCalls.push(this.options);
    }

    setInput(): void {
        // no-op for tests
    }

    destroy(): void {
        this.destroyed = true;
    }
}

const NORWEGIAN_LAYOUT = { layout: { default: ['å nb-row'] } };
const ENGLISH_LAYOUT = { layout: { default: ['a en-row'] } };

function freshLoaders() {
    FakeKeyboard.instances = [];
    FakeKeyboard.setOptionsCalls = [];
    return {
        loadKeyboard: vi.fn<() => Promise<{ default: typeof FakeKeyboard }>>().mockResolvedValue({ default: FakeKeyboard }),
        loadNorwegianLayout: vi.fn<() => Promise<{ default: typeof NORWEGIAN_LAYOUT }>>().mockResolvedValue({ default: NORWEGIAN_LAYOUT }),
        loadEnglishLayout: vi.fn<() => Promise<{ default: typeof ENGLISH_LAYOUT }>>().mockResolvedValue({ default: ENGLISH_LAYOUT }),
    };
}

function decimalInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    document.body.append(input);
    return input;
}

function textInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(input);
    return input;
}

beforeEach(() => {
    mockSettings.set(SettingsSchema.parse({}));
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('mountOnScreenKeyboard', () => {
    it('never imports simple-keyboard until the first eligible focus event', async () => {
        const loaders = freshLoaders();
        const attach = document.createElement('div');
        const handle = mountOnScreenKeyboard(attach, loaders);

        expect(loaders.loadKeyboard).not.toHaveBeenCalled();

        const input = textInput();
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await vi.waitFor(() => {
            expect(loaders.loadKeyboard).toHaveBeenCalledTimes(1);
        });

        handle.dispose();
    });

    it('selects the numeric layout for an inputmode="decimal" input', async () => {
        const loaders = freshLoaders();
        const handle = mountOnScreenKeyboard(document.createElement('div'), loaders);

        const input = decimalInput();
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        await vi.waitFor(() => {
            expect(FakeKeyboard.instances).toHaveLength(1);
        });
        await vi.waitFor(() => {
            expect(loaders.loadNorwegianLayout).not.toHaveBeenCalled();
            expect(loaders.loadEnglishLayout).not.toHaveBeenCalled();
        });
        const kb = FakeKeyboard.instances[0];
        await vi.waitFor(() => {
            expect(kb?.options.layout?.default).toEqual(['1 2 3 4 5 6', '7 8 9 0 , {bksp}']);
        });

        handle.dispose();
    });

    it('selects the Norwegian text layout for a plain text input when language is nb', async () => {
        const loaders = freshLoaders();
        const handle = mountOnScreenKeyboard(document.createElement('div'), loaders);

        const input = textInput();
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        await vi.waitFor(() => {
            expect(loaders.loadNorwegianLayout).toHaveBeenCalledTimes(1);
        });
        expect(loaders.loadEnglishLayout).not.toHaveBeenCalled();

        handle.dispose();
    });

    it('typing on the virtual keyboard dispatches a real input event on the focused input', async () => {
        const loaders = freshLoaders();
        const handle = mountOnScreenKeyboard(document.createElement('div'), loaders);

        const input = textInput();
        const onInput = vi.fn();
        input.addEventListener('input', onInput);
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        await vi.waitFor(() => {
            expect(FakeKeyboard.instances).toHaveLength(1);
        });
        const kb = FakeKeyboard.instances[0];
        kb?.options.onChange?.('hello');

        expect(input.value).toBe('hello');
        expect(onInput).toHaveBeenCalledTimes(1);

        handle.dispose();
    });

    it('switching settings.language swaps the layout live while the keyboard is open', async () => {
        const loaders = freshLoaders();
        const handle = mountOnScreenKeyboard(document.createElement('div'), loaders);

        const input = textInput();
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await vi.waitFor(() => {
            expect(loaders.loadNorwegianLayout).toHaveBeenCalledTimes(1);
        });

        mockSettings.set({ ...mockSettings.get(), language: 'en' });

        await vi.waitFor(() => {
            expect(loaders.loadEnglishLayout).toHaveBeenCalledTimes(1);
        });
        const kb = FakeKeyboard.instances[0];
        expect(kb?.options.layout?.default).toEqual(['a en-row']);

        handle.dispose();
    });

    it('the hide button hides the tray', () => {
        const loaders = freshLoaders();
        const attach = document.createElement('div');
        const handle = mountOnScreenKeyboard(attach, loaders);

        const input = textInput();
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        const tray = attach.querySelector('.keyboard-tray');
        expect(tray?.classList.contains('keyboard-tray--hidden')).toBe(false);

        attach.querySelector<HTMLButtonElement>('.keyboard-tray-hide')?.click();
        expect(tray?.classList.contains('keyboard-tray--hidden')).toBe(true);

        handle.dispose();
    });

    it('hides after a grace period when focus moves outside both the input and the tray', async () => {
        vi.useFakeTimers();
        const loaders = freshLoaders();
        const attach = document.createElement('div');
        const handle = mountOnScreenKeyboard(attach, loaders);

        const input = textInput();
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        const tray = attach.querySelector('.keyboard-tray');
        expect(tray?.classList.contains('keyboard-tray--hidden')).toBe(false);

        const elsewhere = document.createElement('div');
        document.body.append(elsewhere);
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: elsewhere }));

        await vi.advanceTimersByTimeAsync(200);
        expect(tray?.classList.contains('keyboard-tray--hidden')).toBe(true);

        handle.dispose();
    });

    it('is never mounted more than once and dispose() removes it and its listeners', () => {
        const loaders = freshLoaders();
        const attach = document.createElement('div');
        const handle = mountOnScreenKeyboard(attach, loaders);

        expect(attach.querySelectorAll('.keyboard-tray')).toHaveLength(1);

        handle.dispose();
        expect(attach.querySelector('.keyboard-tray')).toBeNull();
    });
});
