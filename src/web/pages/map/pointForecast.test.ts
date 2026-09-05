import { describe, expect, it, vi } from 'vitest';
import weatherFixture from '../../../shared/fixtures/weather.json' with { type: 'json' };
import { createPointForecastController, mountPointForecastPanel } from './pointForecast.js';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

/** A controllable, manually-resolvable fetch stub -- lets a test resolve two "in-flight" requests in whichever order it wants. */
function controllableFetch(): {
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
    resolve: (index: number, body: unknown) => void;
    calls: { url: string; signal: AbortSignal | null | undefined }[];
} {
    const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
    const resolvers: ((value: Response) => void)[] = [];

    const fetch = (input: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url: input, signal: init?.signal });
        return new Promise<Response>((resolve) => {
            resolvers[calls.length - 1] = resolve;
        });
    };

    return {
        fetch,
        calls,
        resolve: (index: number, body: unknown) => {
            resolvers[index]?.(jsonResponse(body));
        },
    };
}

describe('createPointForecastController', () => {
    it('rounds coordinates to 2 decimals before building the request URL', () => {
        const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(jsonResponse(weatherFixture));
        const controller = createPointForecastController(fetchMock);

        controller.requestForecast(68.723456, 15.419999);

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/weather?lat=68.72&lng=15.42');
        controller.dispose();
    });

    it('transitions idle -> loading -> ready on a successful fetch', async () => {
        const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(jsonResponse(weatherFixture));
        const controller = createPointForecastController(fetchMock);

        expect(controller.state.get()).toEqual({ status: 'idle' });
        controller.requestForecast(68.72, 15.42);
        expect(controller.state.get()).toMatchObject({ status: 'loading', lat: 68.72, lng: 15.42 });

        await vi.waitFor(() => {
            expect(controller.state.get().status).toBe('ready');
        });

        controller.dispose();
    });

    it('goes to an error state on a non-ok response', async () => {
        const fetchMock = vi
            .fn<(input: string, init?: RequestInit) => Promise<Response>>()
            .mockResolvedValue(jsonResponse({}, { ok: false, status: 502 }));
        const controller = createPointForecastController(fetchMock);

        controller.requestForecast(68.72, 15.42);

        await vi.waitFor(() => {
            expect(controller.state.get().status).toBe('error');
        });

        controller.dispose();
    });

    it('goes to an error state when the response fails schema validation', async () => {
        const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(jsonResponse({ not: 'weather' }));
        const controller = createPointForecastController(fetchMock);

        controller.requestForecast(68.72, 15.42);

        await vi.waitFor(() => {
            expect(controller.state.get().status).toBe('error');
        });

        controller.dispose();
    });

    it('a second tap aborts the first request', () => {
        const { fetch, calls } = controllableFetch();
        const controller = createPointForecastController(fetch);

        controller.requestForecast(1, 1);
        controller.requestForecast(2, 2);

        expect(calls).toHaveLength(2);
        expect(calls[0]?.signal?.aborted).toBe(true);
        expect(calls[1]?.signal?.aborted).toBe(false);

        controller.dispose();
    });

    it('only the LATEST request is ever displayed, even if an earlier one resolves after it', async () => {
        const { fetch, resolve } = controllableFetch();
        const controller = createPointForecastController(fetch);

        controller.requestForecast(1, 1); // request #0
        controller.requestForecast(2, 2); // request #1 -- supersedes #0

        // The newer request (#1) resolves FIRST...
        resolve(1, weatherFixture);
        await vi.waitFor(() => {
            expect(controller.state.get()).toMatchObject({ status: 'ready', lat: 2, lng: 2 });
        });

        // ...then the older, already-superseded request (#0) resolves after it.
        resolve(0, weatherFixture);
        await Promise.resolve();
        await Promise.resolve();

        // The stale response must never overwrite the newer one, even though
        // it resolved later and even though `AbortController.abort()` alone
        // wouldn't have stopped this fake fetch (it never checks its signal).
        expect(controller.state.get()).toMatchObject({ status: 'ready', lat: 2, lng: 2 });

        controller.dispose();
    });

    it('a stale error response is also discarded once superseded', async () => {
        const { fetch, resolve } = controllableFetch();
        const controller = createPointForecastController(fetch);

        controller.requestForecast(1, 1); // request #0
        controller.requestForecast(2, 2); // request #1

        resolve(1, weatherFixture);
        await vi.waitFor(() => {
            expect(controller.state.get()).toMatchObject({ status: 'ready', lat: 2, lng: 2 });
        });

        resolve(0, {}); // #0 would have been a schema-validation error
        await Promise.resolve();
        await Promise.resolve();

        expect(controller.state.get()).toMatchObject({ status: 'ready', lat: 2, lng: 2 });

        controller.dispose();
    });

    it('dispose() aborts any in-flight request', () => {
        const { fetch, calls } = controllableFetch();
        const controller = createPointForecastController(fetch);

        controller.requestForecast(1, 1);
        controller.dispose();

        expect(calls[0]?.signal?.aborted).toBe(true);
    });
});

describe('mountPointForecastPanel', () => {
    it('renders nothing (display:none) while idle', () => {
        const controller = createPointForecastController(vi.fn());
        const container = document.createElement('div');

        const dispose = mountPointForecastPanel(container, controller.state, vi.fn());

        const panel = container.querySelector('.point-forecast-panel');
        expect(panel).toBeInstanceOf(HTMLElement);
        expect((panel as HTMLElement).style.display).toBe('none');

        dispose();
        controller.dispose();
    });

    it('renders the temperature, condition and stats once ready', async () => {
        const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(jsonResponse(weatherFixture));
        const controller = createPointForecastController(fetchMock);
        const container = document.createElement('div');
        const dispose = mountPointForecastPanel(container, controller.state, vi.fn());

        controller.requestForecast(68.72, 15.42);
        await vi.waitFor(() => {
            expect(controller.state.get().status).toBe('ready');
        });

        // Default language is 'nb' (no settings mock in this file), so the
        // decimal separator is a comma, matching artboard 01's "7,4°".
        expect(container.querySelector('.point-forecast-temp')?.textContent).toBe('6,2°');
        expect(container.querySelector('.point-forecast-condition')).not.toBeNull();
        expect(container.querySelector('.point-forecast-stats')).not.toBeNull();

        dispose();
        controller.dispose();
    });

    it('shows a retry affordance on error, and calls the retry callback with the tapped coordinates', async () => {
        const fetchMock = vi
            .fn<(input: string, init?: RequestInit) => Promise<Response>>()
            .mockResolvedValue(jsonResponse({}, { ok: false, status: 502 }));
        const controller = createPointForecastController(fetchMock);
        const container = document.createElement('div');
        const onRetry = vi.fn();
        const dispose = mountPointForecastPanel(container, controller.state, onRetry);

        controller.requestForecast(68.72, 15.42);
        await vi.waitFor(() => {
            expect(controller.state.get().status).toBe('error');
        });

        const retryButton = container.querySelector<HTMLButtonElement>('.point-forecast-retry');
        expect(retryButton).not.toBeNull();
        retryButton?.click();

        expect(onRetry).toHaveBeenCalledWith(68.72, 15.42);

        dispose();
        controller.dispose();
    });
});
