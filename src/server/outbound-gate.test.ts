import { describe, expect, it } from 'vitest';
import { createOutboundGate } from './outbound-gate.js';

const INTERVAL_MS = 2000;

describe('createOutboundGate', () => {
    it('starts full, so the first visitor is never made to wait for a refill', () => {
        const gate = createOutboundGate({ minIntervalMs: INTERVAL_MS, burst: 4 });

        expect(gate.tryTake(0)).toBe(true);
    });

    it('allows a burst and then refuses, rather than spreading the burst out', () => {
        const gate = createOutboundGate({ minIntervalMs: INTERVAL_MS, burst: 4 });

        // A real pan: several `moveend`s inside a second or two.
        expect(gate.tryTake(0)).toBe(true);
        expect(gate.tryTake(100)).toBe(true);
        expect(gate.tryTake(200)).toBe(true);
        expect(gate.tryTake(300)).toBe(true);
        expect(gate.tryTake(400)).toBe(false);
    });

    it('allows exactly one more take per refill period', () => {
        const gate = createOutboundGate({ minIntervalMs: INTERVAL_MS, burst: 4 });

        for (let i = 0; i < 4; i += 1) expect(gate.tryTake(0)).toBe(true);
        expect(gate.tryTake(0)).toBe(false);

        expect(gate.tryTake(INTERVAL_MS)).toBe(true);
        expect(gate.tryTake(INTERVAL_MS)).toBe(false);

        expect(gate.tryTake(2 * INTERVAL_MS)).toBe(true);
        expect(gate.tryTake(2 * INTERVAL_MS)).toBe(false);
    });

    it('never banks more than the burst, however long it has been quiet', () => {
        const gate = createOutboundGate({ minIntervalMs: INTERVAL_MS, burst: 3 });

        // An hour of nobody looking at the map must not buy an hour's
        // worth of requests the moment somebody does.
        for (let i = 0; i < 3; i += 1) expect(gate.tryTake(3_600_000)).toBe(true);
        expect(gate.tryTake(3_600_000)).toBe(false);
    });

    it('holds the long-run average at one per interval', () => {
        const gate = createOutboundGate({ minIntervalMs: INTERVAL_MS, burst: 4 });

        let taken = 0;
        // One minute, asked every 100ms the way a busy map would.
        for (let nowMs = 0; nowMs <= 60_000; nowMs += 100) {
            if (gate.tryTake(nowMs)) taken += 1;
        }

        // 60s / 2s = 30, plus the initial burst of 4 already in the bucket.
        expect(taken).toBeLessThanOrEqual(34);
        expect(taken).toBeGreaterThanOrEqual(30);
    });

    it('does not mint tokens or strand the bucket when the clock goes backwards', () => {
        const gate = createOutboundGate({ minIntervalMs: INTERVAL_MS, burst: 2 });

        expect(gate.tryTake(10_000)).toBe(true);
        expect(gate.tryTake(10_000)).toBe(true);
        expect(gate.tryTake(10_000)).toBe(false);

        // NTP steps the clock back an hour: no free tokens...
        expect(gate.tryTake(10_000 - 3_600_000)).toBe(false);

        // ...and the bucket still refills normally from there.
        expect(gate.tryTake(10_000 - 3_600_000 + INTERVAL_MS)).toBe(true);
    });

    it('defaults to a plain minimum interval when no burst is given', () => {
        const gate = createOutboundGate({ minIntervalMs: INTERVAL_MS });

        expect(gate.tryTake(0)).toBe(true);
        expect(gate.tryTake(INTERVAL_MS - 1)).toBe(false);
        expect(gate.tryTake(INTERVAL_MS)).toBe(true);
    });
});
