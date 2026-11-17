import { defineConfig } from 'vitest/config';

// This suite lives outside packages/, so the workspace config does not pick it
// up. Run it with: npx vitest run --config reports/gym-oracles/vitest.config.ts
export default defineConfig({
    test: {
        environment: 'node',
        root: import.meta.dirname,
        include: ['*.test.ts'],
    },
});
