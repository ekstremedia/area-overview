import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './version.js';

describe('APP_VERSION', () => {
    it('is a non-empty semantic version string', () => {
        expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
