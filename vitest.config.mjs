import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage is scoped to the pure, platform-independent logic. Browser-extension runtime
      // glue (service-worker.js, offscreen.js, inference-engine.js, model-manager.js) is covered
      // by the e2e suite in real Chrome, which is the only faithful environment for it.
      include: ['src/shared/**/*.js'],
      exclude: ['src/**/vendor/**'],
      thresholds: {
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
