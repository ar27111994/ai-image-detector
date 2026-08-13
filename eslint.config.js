import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'bench/data/**',
      'bench/cache/**',
      'bench/results/**',
      'models-cache/**',
      '.planning/**',
      '.venv/**',
    ],
  },
  js.configs.recommended,
  prettier,
  {
    files: ['src/**/*.js', 'bench/**/*.mjs', 'tools/**/*.mjs', 'tests/**/*.js', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        DataView: 'readonly',
        Uint8Array: 'readonly',
        Uint8ClampedArray: 'readonly',
        Float32Array: 'readonly',
        ArrayBuffer: 'readonly',
        Blob: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        structuredClone: 'readonly',
        indexedDB: 'readonly',
        DecompressionStream: 'readonly',
        WritableStream: 'readonly',
        ReadableStream: 'readonly',
        performance: 'readonly',
        ImageData: 'readonly',
        OffscreenCanvas: 'readonly',
        createImageBitmap: 'readonly',
        ImageBitmap: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['info', 'warn', 'error', 'debug'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
    },
  },
  {
    // Node-side scripts (build, bench, tools).
    files: ['bench/**/*.mjs', 'tools/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Extension runtime files additionally see the chrome API + DOM.
    files: ['src/**/*.js'],
    languageOptions: {
      globals: {
        chrome: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        self: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        location: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  },
  {
    // E2E harness: Node process driving a browser (page.evaluate bodies see DOM globals).
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        chrome: 'readonly',
        location: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
