/**
 * Proves the content pages poll independently: each owns its own
 * `resource()` instance (see each page's own doc comment), so a failing
 * fetch on one page's endpoint can never affect another page's rendered
 * state. Mounted together in the same test (both are plain DOM, no
 * shared container) with one `fetch` mock that fails only the aurora
 * endpoint.
 */
import { describe, expect, it, vi } from 'vitest';
import weatherFixture from '../../shared/fixtures/weather.json' with { type: 'json' };
import weatherSummaryFixture from '../../shared/fixtures/weather-summary.json' with { type: 'json' };
import { SettingsSchema, type Settings } from '../../shared/schemas/settings.js';
import { signal } from '../core/signal.js';

const mockSettings = signal<Settings>(SettingsSchema.parse({}));
vi.mock('../settings-resource.js', () => ({ settings: mockSettings }));

const { render: renderWeather } = await import('./WeatherPage.js');
const { render: renderAurora } = await import('./AuroraPage.js');

function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

describe('independent per-page polling', () => {
    it("a failing aurora fetch never affects the weather page's rendered state", async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                if (url.startsWith('/api/aurora')) return Promise.reject(new Error('aurora upstream down'));
                if (url.startsWith('/api/weather/summary')) return Promise.resolve(jsonResponse(weatherSummaryFixture));
                if (url.startsWith('/api/weather')) return Promise.resolve(jsonResponse(weatherFixture));
                return Promise.reject(new Error(`unexpected fetch: ${url}`));
            }),
        );

        const weatherContainer = document.createElement('div');
        const disposeWeather = renderWeather(weatherContainer);
        const auroraContainer = document.createElement('div');
        const disposeAurora = renderAurora(auroraContainer);

        await vi.waitFor(() => {
            expect(auroraContainer.querySelector('.error-band')).not.toBeNull();
        });

        // The aurora page is in its error state throughout, yet the weather
        // page -- mounted at the same time, polling a completely different
        // resource() instance -- still reaches `ready` with real data.
        await vi.waitFor(() => {
            expect(weatherContainer.querySelector('.weather-temp')).not.toBeNull();
        });
        expect(weatherContainer.querySelector('.weather-temp')?.textContent).toBe('6,2°');
        expect(weatherContainer.querySelector('.error-band')).toBeNull();

        disposeWeather();
        disposeAurora();
    });
});
