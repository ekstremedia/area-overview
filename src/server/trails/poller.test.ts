/**
 * The poller's whole job is to be unkillable: an upstream being down is
 * ordinary here, and the only unacceptable outcomes are a schedule that
 * stops and a process that dies. Every test below is some version of
 * that.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { err, ok, type Result } from '../../shared/result.js';
import { startTrailPoller, type TrailPollerSource } from './poller.js';

/** Records what the poller reported without printing it, and stays typed so a test can assert on the spies. */
function quietLogger() {
    return { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
}

function asLogger(logger: ReturnType<typeof quietLogger>): FastifyBaseLogger {
    return logger as unknown as FastifyBaseLogger;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('startTrailPoller', () => {
    it('polls once immediately, so a fresh boot has something before the first interval', async () => {
        vi.useFakeTimers();
        const poll = vi.fn<() => Promise<Result<void>>>().mockResolvedValue(ok(undefined));
        const stop = startTrailPoller([{ name: 'ships', poll }], { intervalMs: 30_000, logger: asLogger(quietLogger()) });

        await vi.advanceTimersByTimeAsync(0);
        expect(poll).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(poll).toHaveBeenCalledTimes(2);

        stop();
    });

    it('keeps polling after a source reports a failure', async () => {
        vi.useFakeTimers();
        const logger = quietLogger();
        const poll = vi
            .fn<() => Promise<Result<void>>>()
            .mockResolvedValueOnce(err({ message: 'BarentsWatch timed out' }))
            .mockResolvedValue(ok(undefined));
        const stop = startTrailPoller([{ name: 'ships', poll }], { intervalMs: 10_000, logger: asLogger(logger) });

        await vi.advanceTimersByTimeAsync(0);
        expect(logger.warn).toHaveBeenCalled(); // reported, not swallowed

        await vi.advanceTimersByTimeAsync(10_000);
        expect(poll).toHaveBeenCalledTimes(2); // and the schedule survived it

        stop();
    });

    it('keeps polling after a source throws, rather than letting an unhandled rejection escape a timer', async () => {
        vi.useFakeTimers();
        const logger = quietLogger();
        const poll = vi.fn<() => Promise<Result<void>>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(ok(undefined));
        const stop = startTrailPoller([{ name: 'aircraft', poll }], { intervalMs: 10_000, logger: asLogger(logger) });

        await vi.advanceTimersByTimeAsync(0);
        expect(logger.error).toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(poll).toHaveBeenCalledTimes(2);

        stop();
    });

    it('polls sources independently, so one dead upstream does not stop the other', async () => {
        vi.useFakeTimers();
        const failing = vi.fn<() => Promise<Result<void>>>().mockResolvedValue(err({ message: 'down' }));
        const healthy = vi.fn<() => Promise<Result<void>>>().mockResolvedValue(ok(undefined));
        const sources: TrailPollerSource[] = [
            { name: 'ships', poll: failing },
            { name: 'aircraft', poll: healthy },
        ];
        const stop = startTrailPoller(sources, { intervalMs: 10_000, logger: asLogger(quietLogger()) });

        await vi.advanceTimersByTimeAsync(10_000);

        expect(failing).toHaveBeenCalledTimes(2);
        expect(healthy).toHaveBeenCalledTimes(2);

        stop();
    });

    it('stops polling once stopped', async () => {
        vi.useFakeTimers();
        const poll = vi.fn<() => Promise<Result<void>>>().mockResolvedValue(ok(undefined));
        const stop = startTrailPoller([{ name: 'ships', poll }], { intervalMs: 10_000, logger: asLogger(quietLogger()) });

        await vi.advanceTimersByTimeAsync(0);
        stop();

        await vi.advanceTimersByTimeAsync(60_000);
        expect(poll).toHaveBeenCalledTimes(1);
    });
});
