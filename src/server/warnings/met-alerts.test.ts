import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bbox } from '../layers/bbox.js';
import { createOutboundGate } from '../outbound-gate.js';
import alertsFixture from './fixtures/met-alerts-northern-norway.json' with { type: 'json' };
import { MET_ALERTS_URL, fetchMetAlerts, mapMetAlerts, type RawMetFeature } from './met-alerts.js';

/** The Vesterålen/Ofoten test bbox shared with `regions.test.ts`, `avalanche.test.ts` and `../routes/warnings.test.ts` -- see `fixtures/README.md`. */
const TEST_BBOX: Bbox = { minLat: 68.35, minLng: 14.5, maxLat: 69.05, maxLng: 16.5 };

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('fetchMetAlerts', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetches the nationwide feature collection, identifying itself via User-Agent', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(alertsFixture));

        const result = await fetchMetAlerts({ upstreamTimeoutMs: 1000, userAgent: 'area-overview-test/0.1', fetchImpl: fetchMock });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(alertsFixture.features.length);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(MET_ALERTS_URL);
        expect((init.headers as Record<string, string>)['User-Agent']).toBe('area-overview-test/0.1');
    });

    it('never sends a county/lat/lon filter -- MET fetches nationwide unconditionally', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(alertsFixture));

        await fetchMetAlerts({ upstreamTimeoutMs: 1000, userAgent: 'area-overview-test/0.1', fetchImpl: fetchMock });

        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toBe(MET_ALERTS_URL);
        expect(url).not.toContain('?');
    });

    it('reports a network failure, a bad status and a non-JSON body as errors', async () => {
        const failed = await fetchMetAlerts({ upstreamTimeoutMs: 1000, userAgent: 'x', fetchImpl: vi.fn().mockRejectedValue(new Error('down')) });
        const badStatus = await fetchMetAlerts({
            upstreamTimeoutMs: 1000,
            userAgent: 'x',
            fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
        });
        const notJson = await fetchMetAlerts({
            upstreamTimeoutMs: 1000,
            userAgent: 'x',
            fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
        });

        expect(failed.ok).toBe(false);
        expect(badStatus.ok).toBe(false);
        expect(notJson.ok).toBe(false);
    });

    it('reports a shut gate as an ordinary error without calling upstream', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(alertsFixture));
        const gate = createOutboundGate({ minIntervalMs: 600_000, burst: 1 });

        const first = await fetchMetAlerts({ upstreamTimeoutMs: 1000, userAgent: 'x', gate, fetchImpl: fetchMock });
        const second = await fetchMetAlerts({ upstreamTimeoutMs: 1000, userAgent: 'x', gate, fetchImpl: fetchMock });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('mapMetAlerts', () => {
    it('maps the three-colour spread via riskMatrixColor and excludes the alert whose polygon misses the bbox', () => {
        const { warnings, discarded } = mapMetAlerts(alertsFixture.features as unknown as RawMetFeature[], TEST_BBOX);

        expect(discarded).toBe(0);
        const ids = warnings.map((warning) => warning.id);
        expect(ids).toContain('2.49.0.1.578.0.1');
        expect(ids).toContain('2.49.0.1.578.0.2');
        expect(ids).toContain('2.49.0.1.578.0.3');
        // The Oslo storm surge: geographically nowhere near the bbox.
        expect(ids).not.toContain('2.49.0.1.578.0.4');

        const gale = warnings.find((warning) => warning.id === '2.49.0.1.578.0.1');
        expect(gale?.awarenessLevel).toBe('yellow');
        const snow = warnings.find((warning) => warning.id === '2.49.0.1.578.0.2');
        expect(snow?.awarenessLevel).toBe('orange');
        expect(snow?.area).toBeNull();
        expect(snow?.consequences).toBeNull();
        const ice = warnings.find((warning) => warning.id === '2.49.0.1.578.0.3');
        expect(ice?.awarenessLevel).toBe('red');
        expect(ice?.endsAt).toBeNull();
    });

    it("falls back to parsing awareness_level's triple when riskMatrixColor is absent", () => {
        const { warnings } = mapMetAlerts(alertsFixture.features as unknown as RawMetFeature[], TEST_BBOX);

        const wind = warnings.find((warning) => warning.id === '2.49.0.1.578.0.5');
        expect(wind).toBeDefined();
        expect(wind?.awarenessLevel).toBe('yellow');
    });

    it('discards a feature whose properties are missing required fields, without failing the batch', () => {
        const broken: RawMetFeature[] = [
            {
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [14.8, 68.5],
                            [15.2, 68.5],
                            [15.2, 68.7],
                            [14.8, 68.7],
                            [14.8, 68.5],
                        ],
                    ],
                },
                properties: { id: 'broken-1' }, // missing event, eventAwarenessName, description, title
            },
            ...(alertsFixture.features as unknown as RawMetFeature[]),
        ];

        const { warnings, discarded } = mapMetAlerts(broken, TEST_BBOX);

        expect(discarded).toBe(1);
        expect(warnings.map((warning) => warning.id)).not.toContain('broken-1');
        // The rest of the batch is unaffected.
        expect(warnings.length).toBeGreaterThan(0);
    });

    it('handles a MultiPolygon geometry by taking the outer ring of each part', () => {
        const multi: RawMetFeature[] = [
            {
                geometry: {
                    type: 'MultiPolygon',
                    coordinates: [
                        [
                            [
                                [14.8, 68.5],
                                [15.2, 68.5],
                                [15.2, 68.7],
                                [14.8, 68.7],
                                [14.8, 68.5],
                            ],
                        ],
                        [
                            [
                                [10.5, 59.8],
                                [10.9, 59.8],
                                [10.9, 60.0],
                                [10.5, 60.0],
                                [10.5, 59.8],
                            ],
                        ],
                    ],
                },
                properties: {
                    id: 'multi-1',
                    event: 'gale',
                    riskMatrixColor: 'Yellow',
                    eventAwarenessName: 'Kuling',
                    description: 'desc',
                    title: 'Kuling, gult nivå, Vesterålen, 2026-09-16T06:00:00+00:00, 2026-09-17T06:00:00+00:00',
                },
            },
        ];

        const { warnings } = mapMetAlerts(multi, TEST_BBOX);

        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.polygon).toHaveLength(2);
    });

    it('excludes a feature with no usable geometry at all, without counting it as a discard', () => {
        const noGeometry: RawMetFeature[] = [
            {
                geometry: null,
                properties: {
                    id: 'no-geometry-1',
                    event: 'gale',
                    riskMatrixColor: 'Yellow',
                    eventAwarenessName: 'Kuling',
                    description: 'desc',
                    title: 'Kuling, gult nivå, Vesterålen, 2026-09-16T06:00:00+00:00, 2026-09-17T06:00:00+00:00',
                },
            },
        ];

        const { warnings, discarded } = mapMetAlerts(noGeometry, TEST_BBOX);

        expect(warnings).toHaveLength(0);
        expect(discarded).toBe(0);
    });

    it('pulls startsAt out of title (there is no dedicated start-time field), matching endsAt for the trailing segment', () => {
        const { warnings } = mapMetAlerts(alertsFixture.features as unknown as RawMetFeature[], TEST_BBOX);

        const gale = warnings.find((warning) => warning.id === '2.49.0.1.578.0.1');
        expect(gale?.startsAt).toBe('2026-09-16T06:00:00+00:00');
        expect(gale?.endsAt).toBe('2026-09-17T06:00:00+00:00');

        // `...0.3`'s title carries only a start time (mirrors a real alert
        // with no `eventEndingTime`) -- the single timestamp must still be
        // read as the start, not mistaken for an end.
        const ice = warnings.find((warning) => warning.id === '2.49.0.1.578.0.3');
        expect(ice?.startsAt).toBe('2026-09-16T00:00:00+00:00');
        expect(ice?.endsAt).toBeNull();
    });

    it('treats a single title timestamp equal to eventEndingTime as an unknown start, not a misread end', () => {
        const ambiguous: RawMetFeature[] = [
            {
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [14.8, 68.5],
                            [15.2, 68.5],
                            [15.2, 68.7],
                            [14.8, 68.7],
                            [14.8, 68.5],
                        ],
                    ],
                },
                properties: {
                    id: 'ambiguous-1',
                    event: 'gale',
                    riskMatrixColor: 'Yellow',
                    eventAwarenessName: 'Kuling',
                    description: 'desc',
                    // The only timestamp in the title is actually the end
                    // time (matches eventEndingTime exactly) -- reading it
                    // as startsAt would be wrong, not just imprecise.
                    title: 'Kuling, gult nivå, Vesterålen, 2026-09-17T06:00:00+00:00',
                    eventEndingTime: '2026-09-17T06:00:00+00:00',
                },
            },
        ];

        const { warnings, discarded } = mapMetAlerts(ambiguous, TEST_BBOX);

        expect(warnings).toHaveLength(0);
        expect(discarded).toBe(1);
    });

    it('discards a feature whose title carries no ISO timestamp at all -- there is nothing to use as startsAt', () => {
        const noStartTime: RawMetFeature[] = [
            {
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [14.8, 68.5],
                            [15.2, 68.5],
                            [15.2, 68.7],
                            [14.8, 68.7],
                            [14.8, 68.5],
                        ],
                    ],
                },
                properties: {
                    id: 'no-start-1',
                    event: 'gale',
                    riskMatrixColor: 'Yellow',
                    eventAwarenessName: 'Kuling',
                    description: 'desc',
                    title: 'Kuling, gult nivå, Vesterålen', // no embedded timestamp
                },
            },
        ];

        const { warnings, discarded } = mapMetAlerts(noStartTime, TEST_BBOX);

        expect(warnings).toHaveLength(0);
        expect(discarded).toBe(1);
    });
});
