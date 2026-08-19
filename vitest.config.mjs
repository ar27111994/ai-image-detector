import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Coverage spans ALL of src/ and the gate is 90% on every metric. The pure logic
      // (src/shared, model-manager) sits near 100%; the runtime/UI modules (service worker,
      // offscreen orchestrator + inference engine, content script, pages) are unit-tested via
      // the shared DOM/chrome stub with onnxruntime-web and canvas mocked. The remaining
      // hard-to-reach lines (live WebGPU/WASM session internals) are covered by the e2e suite.
      include: ['src/**/*.js'],
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
