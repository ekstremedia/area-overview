import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/aurora.json' with { type: 'json' };
import { AuroraAllSchema, AuroraOvalSchema, AuroraStatusSchema } from './aurora.js';
import { omitKey } from './test-utils.js';

describe('AuroraAllSchema', () => {
    it('parses the recorded /api/aurora/all fixture', () => {
        expect(() => AuroraAllSchema.parse(fixture)).not.toThrow();
    });

    it('rejects a fixture missing the required attribution field', () => {
        const withoutAttribution = omitKey(fixture, 'attribution');
        const result = AuroraAllSchema.safeParse(withoutAttribution);
        expect(result.success).toBe(false);
    });

    it('accepts a fixture with an extra unknown top-level field', () => {
        const result = AuroraAllSchema.safeParse({ ...fixture, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });
});

describe('AuroraStatusSchema', () => {
    it('parses the status block of the fixture', () => {
        expect(() => AuroraStatusSchema.parse(fixture.status)).not.toThrow();
    });

    it('rejects a status block missing the required attributionUrl field', () => {
        const withoutAttributionUrl = omitKey(fixture.status, 'attributionUrl');
        const result = AuroraStatusSchema.safeParse(withoutAttributionUrl);
        expect(result.success).toBe(false);
    });
});

describe('AuroraOvalSchema', () => {
    it('parses the oval block of the fixture', () => {
        expect(() => AuroraOvalSchema.parse(fixture.oval)).not.toThrow();
    });

    it('rejects an oval block missing the required images field', () => {
        const withoutImages = omitKey(fixture.oval, 'images');
        const result = AuroraOvalSchema.safeParse(withoutImages);
        expect(result.success).toBe(false);
    });

    it('accepts an oval block with an extra unknown field', () => {
        const result = AuroraOvalSchema.safeParse({ ...fixture.oval, unexpectedNewField: 'value' });
        expect(result.success).toBe(true);
    });
});
