/**
 * Build script: bundles extension JS with esbuild and copies static assets to dist/.
 * Usage:
 *   node build.mjs            production build
 *   node build.mjs --watch    incremental rebuild on change
 *   node build.mjs --debug    non-minified with inline sourcemaps
 */
import { build, context } from 'esbuild';
import { copyFile, cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(repoRoot, 'dist');
const extensionDir = path.join(repoRoot, 'extension');
const ortDistDir = path.join(repoRoot, 'node_modules', 'onnxruntime-web', 'dist');

const isWatch = process.argv.includes('--watch');
const isDebug = process.argv.includes('--debug');

/**
 * The vendored ORT wasm/mjs assets are version-locked to the onnxruntime-web JS bundle (minified
 * internal names change per release). Fail the build loudly if the installed onnxruntime-web and
 * onnxruntime-node versions drift apart or the expected wasm files are absent — this is the
 * invariant Dependabot's ORT auto-merge relies on.
 */
async function verifyOrtVersionCoupling() {
  const readPkg = async (name) =>
    JSON.parse(await readFile(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'));
  const web = await readPkg('onnxruntime-web');
  const node = await readPkg('onnxruntime-node');
  if (web.version !== node.version) {
    throw new Error(
      `onnxruntime version mismatch: web=${web.version} node=${node.version}. ` +
        'They must be pinned to the same version (see docs/ARCHITECTURE.md).',
    );
  }
  for (const file of ORT_ASSETS) {
    await stat(path.join(ortDistDir, file)); // throws if a bump renamed/removed a vendored asset
  }
}

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

  // License + third-party notices ship inside the package so the installed
  // extension is self-documenting (REQ-21).
  await copyFile(path.join(repoRoot, 'LICENSE'), path.join(distDir, 'LICENSE'));
  await copyFile(path.join(repoRoot, 'NOTICE'), path.join(distDir, 'NOTICE'));

  // Vendored ORT WebAssembly assets (exact filenames verified to exist)
  const vendorDir = path.join(distDir, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  for (const file of ORT_ASSETS) {
    const src = path.join(ortDistDir, file);
    await stat(src); // throws with a clear error if the pinned ORT version renamed files
    await copyFile(src, path.join(vendorDir, file));
  }
  await verifyOrtVersionCoupling();

  // Model manifest (URLs + SHA-256 of weights; weights themselves download at first-run setup).
  // The manifest is mandatory: without it the built extension reaches onboarding but cannot
  // install a model, so a missing/unreadable manifest must fail the build, not silently pass.
  const modelsManifest = path.join(repoRoot, 'models', 'manifest.json');
  await mkdir(path.join(distDir, 'models'), { recursive: true });
  await copyFile(modelsManifest, path.join(distDir, 'models', 'manifest.json'));
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
  await assertContentScriptIsIife();
  const files = await readdir(distDir);
  console.log(`[build] dist/ written: ${files.join(', ')}`);
  if (results.some((r) => r.errors.length > 0)) process.exitCode = 1;
}

/**
 * Fail the build if dist/content.js is not a classic-script (IIFE) bundle. Content scripts run
 * in the page's classic-script world — a top-level ESM import/export would be a SyntaxError
 * there. This scans *outside* strings/comments (so a mention of the word inside a string or
 * comment never false-positives) for a top-level `import`/`export` statement.
 */
async function assertContentScriptIsIife() {
  const src = await readFile(path.join(distDir, 'content.js'), 'utf8');
  if (hasTopLevelEsm(src)) {
    throw new Error(
      'dist/content.js contains a top-level import/export — content scripts must be IIFE ' +
        '(esbuild format "iife"). Check buildConfigs() format for the content entry.',
    );
  }
}

/**
 * Scan source for a top-level `import`/`export` keyword while skipping string literals,
 * template literals, and line/block comments. Depth-0 (top-level) occurrences only.
 * @param {string} src
 * @returns {boolean} true if a top-level ESM statement is present
 */
export function hasTopLevelEsm(src) {
  let depth = 0;
  let i = 0;
  const n = src.length;
  // State machine over: code, line comment, block comment, single/double-quoted string,
  // template literal. Only inspect tokens at brace/paren/bracket depth 0 in "code" state.
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // Comments
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Strings / template literals (skip to their end, honoring escapes)
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1);
    // Top-level keyword check (word-boundary so 'imported'/'myexport' don't match).
    else if (depth === 0 && /[A-Za-z]/.test(c)) {
      const rest = src.slice(i);
      const m = rest.match(/^(import|export)\b/);
      if (m) {
        // Allow `export {};`/`export {}`? No — that is still ESM and forbidden in classic scripts.
        // Any top-level import/export statement means the bundle is ESM, not IIFE.
        return true;
      }
      // Skip past this identifier/keyword.
      const word = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      i += word ? word[0].length : 1;
      continue;
    }
    i++;
  }
  return false;
}

// Only auto-run when executed directly (not when imported by tests for the validator).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((err) => {
    console.error('[build] failed:', err);
    process.exitCode = 1;
  });
}
