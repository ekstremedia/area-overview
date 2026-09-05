import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'happy-dom',
        setupFiles: ['./src/web/test-setup.ts'],
    },
    resolve: {
        alias: {
            '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
        },
    },
});
