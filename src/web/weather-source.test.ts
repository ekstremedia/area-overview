import { describe, expect, it } from 'vitest';
import offlineFixture from '../shared/fixtures/weather-netatmo-offline.json' with { type: 'json' };
import weatherFixture from '../shared/fixtures/weather.json' with { type: 'json' };
import { WeatherSchema } from '../shared/schemas/weather.js';
import { currentSourceKey } from './weather-source.js';

describe('currentSourceKey', () => {
    it('says Yr when every reading is Yr, rather than claiming Netatmo', () => {
        // The old hardcoded label said "Netatmo · ute" over these exact
        // values. This fixture is a real capture taken while the station
        // was offline.
        const offline = WeatherSchema.parse(offlineFixture);

        expect(currentSourceKey(offline.current)).toBe('weather.sourceYr');
    });

    it('says mixed when the station supplies the measurements and Yr the conditions', () => {
        const live = WeatherSchema.parse(weatherFixture);

        expect(currentSourceKey(live.current)).toBe('weather.sourceMixed');
    });

    it('says Netatmo only when every reading really is the station', () => {
        const live = WeatherSchema.parse(weatherFixture);
        const allStation = {
            ...live.current,
            conditions: { ...live.current.conditions, source: 'netatmo' },
        };

        expect(currentSourceKey(allStation)).toBe('weather.sourceNetatmo');
    });

    it('ignores current.source, which describes the document rather than this column', () => {
        // The offline capture carries `current.source: "mixed"` while
        // every sub-field is Yr's -- reading it would reproduce the very
        // bug this function replaces.
        const offline = WeatherSchema.parse(offlineFixture);
        expect(offline.current.source).toBe('mixed');

        expect(currentSourceKey(offline.current)).toBe('weather.sourceYr');
    });
});
