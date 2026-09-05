import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'happy-dom',
    },
    resolve: {
        alias: {
            '@shared': new URL('./src/shared', import.meta.url).pathname,
        },
    },
});
