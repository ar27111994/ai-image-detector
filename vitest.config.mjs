import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage is scoped to the pure, platform-independent logic plus the model manager
      // (heavily unit-tested). The service worker router / offscreen inference engine / content
      // script are covered by the integration (mock-chrome) and e2e suites in real Chrome.
      include: ['src/shared/**/*.js', 'src/background/model-manager.js'],
      exclude: ['src/**/vendor/**'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
