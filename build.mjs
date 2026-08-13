/**
 * Build script: bundles extension JS with esbuild and copies static assets to dist/.
 * Usage:
 *   node build.mjs            production build
 *   node build.mjs --watch    incremental rebuild on change
 *   node build.mjs --debug    non-minified with inline sourcemaps
 */
import { build, context } from 'esbuild';
import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(repoRoot, 'dist');
const extensionDir = path.join(repoRoot, 'extension');
const ortDistDir = path.join(repoRoot, 'node_modules', 'onnxruntime-web', 'dist');

const isWatch = process.argv.includes('--watch');
const isDebug = process.argv.includes('--debug');

/** ORT runtime assets vendored into the extension (see docs/ARCHITECTURE.md). */
const ORT_ASSETS = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];

const ENTRY_POINTS = {
  background: 'src/background/service-worker.js',
  offscreen: 'src/offscreen/offscreen.js',
  content: 'src/content/content.js',
  popup: 'src/popup/popup.js',
  options: 'src/options/options.js',
  onboarding: 'src/onboarding/onboarding.js',
};

async function copyStatic() {
  await mkdir(distDir, { recursive: true });

  // Manifest + icons + pages
  await copyFile(path.join(extensionDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  await cp(path.join(extensionDir, 'icons'), path.join(distDir, 'icons'), { recursive: true });
  await cp(path.join(extensionDir, 'pages'), path.join(distDir, 'pages'), { recursive: true });

  // Vendored ORT WebAssembly assets (exact filenames verified to exist)
  const vendorDir = path.join(distDir, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  for (const file of ORT_ASSETS) {
    const src = path.join(ortDistDir, file);
    await stat(src); // throws with a clear error if the pinned ORT version renamed files
    await copyFile(src, path.join(vendorDir, file));
  }

  // Model manifest (URLs + SHA-256 of weights; weights themselves download at first-run setup)
  const modelsManifest = path.join(repoRoot, 'models', 'manifest.json');
  try {
    await mkdir(path.join(distDir, 'models'), { recursive: true });
    await copyFile(modelsManifest, path.join(distDir, 'models', 'manifest.json'));
  } catch {
    console.warn('[build] models/manifest.json not found yet — skipping (added in Phase 1 task 3)');
  }
}

/**
 * Content scripts run as classic scripts in an isolated world — ESM output would be a syntax
 * error there. Everything else (SW declared as `"type": "module"`, extension pages loaded via
 * `<script type="module">`) uses ESM.
 * @returns {import('esbuild').BuildOptions[]}
 */
function buildConfigs() {
  const shared = {
    bundle: true,
    target: 'chrome116',
    platform: 'browser',
    sourcemap: isDebug ? 'inline' : false,
    minify: !isDebug && !isWatch,
    logLevel: 'info',
    // onnxruntime-web is imported by the offscreen bundle only; keep it external-free
    // (bundled) so the extension never touches the network for code.
    define: {
      'process.env.NODE_ENV': JSON.stringify(isDebug ? 'development' : 'production'),
    },
  };

  const { content: contentEntry, ...moduleEntries } = ENTRY_POINTS;
  return [
    {
      ...shared,
      entryPoints: [path.join(repoRoot, contentEntry)],
      outdir: distDir,
      format: 'iife',
    },
    {
      ...shared,
      entryPoints: Object.fromEntries(
        Object.entries(moduleEntries).map(([name, rel]) => [name, path.join(repoRoot, rel)]),
      ),
      outdir: distDir,
      format: 'esm',
      splitting: true,
    },
  ];
}

async function run() {
  await rm(distDir, { recursive: true, force: true });
  await copyStatic();

  if (isWatch) {
    const contexts = await Promise.all(buildConfigs().map((cfg) => context(cfg)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[build] watching for changes…');
    return;
  }

  const results = await Promise.all(buildConfigs().map((cfg) => build(cfg)));
  const files = await readdir(distDir);
  console.log(`[build] dist/ written: ${files.join(', ')}`);
  if (results.some((r) => r.errors.length > 0)) process.exitCode = 1;
}

run().catch((err) => {
  console.error('[build] failed:', err);
  process.exitCode = 1;
});
