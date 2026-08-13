import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/shared/**/*.js', 'src/background/**/*.js', 'src/offscreen/**/*.js'],
      exclude: ['src/**/vendor/**'],
      thresholds: {
        // Shared pure logic must stay near-total; runtime glue is exercised via e2e.
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
