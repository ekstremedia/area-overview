import { describe, expect, it } from 'vitest';
import { omitKey } from './test-utils.js';
import { AvalancheWarningSchema, WeatherWarningSchema, WarningsResponseSchema } from './warnings.js';

const validWeatherWarning = {
    id: 'MET-2026-09-16-gale-1',
    event: 'gale',
    awarenessLevel: 'orange',
    title: 'Kraftig vind',
    description: 'Sterk kuling ventet, opp mot 25 m/s.',
    area: 'Vesterålen',
    consequences: 'Fare for skader på løse gjenstander og skilt.',
    instruction: 'Sikre løse gjenstander.',
    polygon: [
        [
            [68.6, 15.3],
            [68.7, 15.4],
            [68.65, 15.5],
        ],
    ],
    startsAt: '2026-09-16T06:00:00+02:00',
    endsAt: '2026-09-17T06:00:00+02:00',
};

const validAvalancheWarning = {
    regionId: '3015',
    regionName: 'Ofoten',
    dangerLevel: 3,
    validAt: '2026-09-16T00:00:00+02:00',
    outline: [
        [68.6, 15.3],
        [68.7, 15.4],
        [68.65, 15.5],
    ],
    point: { lat: 68.6984, lng: 15.4129 },
};

describe('WeatherWarningSchema', () => {
    it('parses a well-formed weather warning', () => {
        expect(() => WeatherWarningSchema.parse(validWeatherWarning)).not.toThrow();
    });

    it('rejects a warning missing the required id field', () => {
        expect(WeatherWarningSchema.safeParse(omitKey(validWeatherWarning, 'id')).success).toBe(false);
    });

    it('accepts an unfamiliar event string, deliberately unlike awarenessLevel', () => {
        expect(WeatherWarningSchema.safeParse({ ...validWeatherWarning, event: 'somethingNew' }).success).toBe(true);
    });

    it('accepts an unfamiliar awareness level, deliberately unlike a closed enum', () => {
        expect(WeatherWarningSchema.safeParse({ ...validWeatherWarning, awarenessLevel: 'green' }).success).toBe(true);
    });

    it('accepts a null polygon and endsAt', () => {
        expect(WeatherWarningSchema.safeParse({ ...validWeatherWarning, polygon: null, endsAt: null }).success).toBe(true);
    });

    it('rejects a polygon ring with fewer than three points', () => {
        const result = WeatherWarningSchema.safeParse({
            ...validWeatherWarning,
            polygon: [
                [
                    [68.6, 15.3],
                    [68.7, 15.4],
                ],
            ],
        });
        expect(result.success).toBe(false);
    });

    it('accepts a polygon with multiple rings', () => {
        const result = WeatherWarningSchema.safeParse({
            ...validWeatherWarning,
            polygon: [
                [
                    [68.6, 15.3],
                    [68.7, 15.4],
                    [68.65, 15.5],
                ],
                [
                    [69.0, 16.0],
                    [69.1, 16.1],
                    [69.05, 16.2],
                ],
            ],
        });
        expect(result.success).toBe(true);
    });
});

describe('AvalancheWarningSchema', () => {
    it('parses a well-formed avalanche warning', () => {
        expect(() => AvalancheWarningSchema.parse(validAvalancheWarning)).not.toThrow();
    });

    it('rejects a dangerLevel below 1', () => {
        expect(AvalancheWarningSchema.safeParse({ ...validAvalancheWarning, dangerLevel: 0 }).success).toBe(false);
    });

    it('rejects a dangerLevel above 5', () => {
        expect(AvalancheWarningSchema.safeParse({ ...validAvalancheWarning, dangerLevel: 6 }).success).toBe(false);
    });

    it('rejects a non-integer dangerLevel', () => {
        expect(AvalancheWarningSchema.safeParse({ ...validAvalancheWarning, dangerLevel: 2.5 }).success).toBe(false);
    });
});

describe('WarningsResponseSchema', () => {
    it('accepts the configured:true shape with both warning lists', () => {
        const result = WarningsResponseSchema.safeParse({
            configured: true,
            weatherWarnings: [validWeatherWarning],
            avalancheWarnings: [validAvalancheWarning],
            fetchedAt: '2026-09-16T06:00:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('accepts empty warning lists, the common answer for a quiet day', () => {
        const result = WarningsResponseSchema.safeParse({
            configured: true,
            weatherWarnings: [],
            avalancheWarnings: [],
            fetchedAt: '2026-09-16T06:00:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('accepts the configured:false shape', () => {
        expect(WarningsResponseSchema.safeParse({ configured: false }).success).toBe(true);
    });

    it('rejects configured:true missing avalancheWarnings', () => {
        const result = WarningsResponseSchema.safeParse({
            configured: true,
            weatherWarnings: [],
            fetchedAt: '2026-09-16T06:00:00+02:00',
        });
        expect(result.success).toBe(false);
    });

    it('accepts a null avalancheWarnings, meaning that half failed to fetch', () => {
        const result = WarningsResponseSchema.safeParse({
            configured: true,
            weatherWarnings: [validWeatherWarning],
            avalancheWarnings: null,
            fetchedAt: '2026-09-16T06:00:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('accepts a null weatherWarnings, meaning that half failed to fetch', () => {
        const result = WarningsResponseSchema.safeParse({
            configured: true,
            weatherWarnings: null,
            avalancheWarnings: [validAvalancheWarning],
            fetchedAt: '2026-09-16T06:00:00+02:00',
        });
        expect(result.success).toBe(true);
    });

    it('rejects a fetchedAt that is not a parseable timestamp', () => {
        const result = WarningsResponseSchema.safeParse({
            configured: true,
            weatherWarnings: [],
            avalancheWarnings: [],
            fetchedAt: 'nylig',
        });
        expect(result.success).toBe(false);
    });
});
