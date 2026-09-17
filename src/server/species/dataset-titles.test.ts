import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatasetTitleCache, GBIF_DATASET_URL, lookupDatasetTitle } from './dataset-titles.js';

const TEST_USER_AGENT = 'area-overview-test/0.1 (+https://area.nesthus.no; terjen@gmail.com)';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('lookupDatasetTitle', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolves a real title on a successful lookup, and caches it for the same key', async () => {
        const cache = createDatasetTitleCache();
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ title: 'Norwegian Species Observation Service' }));

        const title = await lookupDatasetTitle('9ea87732-b88e-488d-a02b-3dc6e9b885e0', cache, {
            userAgent: TEST_USER_AGENT,
            fetchImpl: fetchMock,
        });

        expect(title).toBe('Norwegian Species Observation Service');
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${GBIF_DATASET_URL}/9ea87732-b88e-488d-a02b-3dc6e9b885e0`);
        expect((init.headers as Record<string, string>)['User-Agent']).toBe(TEST_USER_AGENT);

        // Second lookup of the same key must not call upstream again.
        const cached = await lookupDatasetTitle('9ea87732-b88e-488d-a02b-3dc6e9b885e0', cache, {
            userAgent: TEST_USER_AGENT,
            fetchImpl: fetchMock,
        });
        expect(cached).toBe('Norwegian Species Observation Service');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the key itself, without throwing, on a network failure', async () => {
        const cache = createDatasetTitleCache();
        const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));

        const title = await lookupDatasetTitle('some-dataset-key', cache, { userAgent: TEST_USER_AGENT, fetchImpl: fetchMock });

        expect(title).toBe('some-dataset-key');
    });

    it('falls back to the key itself on a timeout, without exceeding the given budget', async () => {
        const cache = createDatasetTitleCache();
        const fetchMock = vi.fn().mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        reject(new Error('aborted'));
                    });
                }),
        );

        const title = await lookupDatasetTitle('slow-dataset-key', cache, {
            userAgent: TEST_USER_AGENT,
            fetchImpl: fetchMock,
            timeoutMs: 20,
        });

        expect(title).toBe('slow-dataset-key');
    });

    it('falls back to the key itself on a bad status or a malformed body', async () => {
        const cache = createDatasetTitleCache();

        const badStatus = await lookupDatasetTitle('key-a', cache, {
            userAgent: TEST_USER_AGENT,
            fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
        });
        const noTitle = await lookupDatasetTitle('key-b', cache, {
            userAgent: TEST_USER_AGENT,
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse({})),
        });
        const notJson = await lookupDatasetTitle('key-c', cache, {
            userAgent: TEST_USER_AGENT,
            fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })),
        });

        expect(badStatus).toBe('key-a');
        expect(noTitle).toBe('key-b');
        expect(notJson).toBe('key-c');
    });
});
