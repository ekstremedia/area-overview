import { describe, expect, it } from 'vitest';
import { signal } from '../../core/signal.js';
import { mountWhileEnabled } from './liveLayerMount.js';

describe('mountWhileEnabled', () => {
    it('mounts immediately when already enabled', () => {
        let mounted = false;
        const dispose = mountWhileEnabled(
            () => true,
            () => {
                mounted = true;
                return () => {
                    mounted = false;
                };
            },
        );
        expect(mounted).toBe(true);
        dispose();
        expect(mounted).toBe(false);
    });

    it('does not mount at all while disabled', () => {
        let mountCount = 0;
        const dispose = mountWhileEnabled(
            () => false,
            () => {
                mountCount += 1;
                return () => undefined;
            },
        );
        expect(mountCount).toBe(0);
        dispose();
    });

    it('mounts when a reactive enabled signal flips true, and unmounts when it flips back to false', () => {
        const enabled = signal(false);
        let mountCount = 0;
        let disposeCount = 0;

        const dispose = mountWhileEnabled(
            () => enabled.get(),
            () => {
                mountCount += 1;
                return () => {
                    disposeCount += 1;
                };
            },
        );

        expect(mountCount).toBe(0);

        enabled.set(true);
        expect(mountCount).toBe(1);
        expect(disposeCount).toBe(0);

        enabled.set(false);
        expect(disposeCount).toBe(1);

        enabled.set(true);
        expect(mountCount).toBe(2);

        dispose();
        expect(disposeCount).toBe(2);
    });

    it("the outer dispose() tears down an inner mount that's still active, with no leak", () => {
        const enabled = signal(true);
        let disposeCount = 0;

        const dispose = mountWhileEnabled(
            () => enabled.get(),
            () => () => {
                disposeCount += 1;
            },
        );

        dispose();
        expect(disposeCount).toBe(1);

        // Flipping the signal after outer disposal must not remount --
        // the effect itself is torn down.
        enabled.set(false);
        enabled.set(true);
        expect(disposeCount).toBe(1);
    });
});
