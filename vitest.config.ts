import { defineConfig } from 'vitest/config';

// Integration tests are opt-in: they require Postgres and Redis running.
// Set RUN_INTEGRATION=1 or use the `test:integration` script.
const includeIntegration = process.env.RUN_INTEGRATION === '1';

export default defineConfig({
  test: {
    include: includeIntegration
      ? ['test/**/*.test.ts']
      : ['test/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
    },
  },
});
