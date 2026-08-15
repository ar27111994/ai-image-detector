/**
 * Pack the built extension (dist/) into versioned zips for distribution / submission.
 *
 * Two artifacts:
 *   ai-image-detector-<v>.zip         lean — model downloads once at first-run setup (default)
 *   ai-image-detector-<v>-bundled.zip self-contained — model weights embedded, zero download
 *
 * Usage: npm run build && npm run pack [--bundled]
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const releaseDir = path.join(repoRoot, 'release');
const cacheDir = path.join(repoRoot, 'models-cache');

const withBundled = process.argv.includes('--bundled');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function zipDir(srcDir, zipPath) {
  try {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ]);
  } catch {
    await run('tar', ['-a', '-c', '-f', zipPath, '-C', srcDir, '.']);
  }
}

/**
 * Download the pinned model variant into the bundle (with SHA-256 verification) so the
 * bundled zip works fully offline with zero setup download.
 */
async function stageBundledModel(stageDir) {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, 'models', 'manifest.json'), 'utf8'),
  );
  const variant = manifest.variants.find((v) => v.kind === 'wasm') ?? manifest.variants[0];
  if (!variant) throw new Error('manifest has no variants to bundle');

  const destDir = path.join(stageDir, 'models');
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${variant.key}.onnx`);

  // Reuse a cached copy if present and hash-matches; else download from the pinned URL.
  let bytes;
  const cached = path.join(cacheDir, 'haywoodsloan-int8.onnx');
  try {
    await stat(cached);
    bytes = await readFile(cached);
  } catch {
    console.log(`[pack] downloading model for bundle: ${variant.url}`);
    const res = await fetch(variant.url);
    if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }

  // Verify integrity against the manifest pin before embedding.
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (variant.sha256 && sha !== variant.sha256) {
    throw new Error(`bundled model SHA-256 mismatch: expected ${variant.sha256}, got ${sha}`);
  }

  await writeFile(dest, bytes);
  // Also expose the raw model as a standalone release asset so each v* release is self-contained
  // even for users who prefer the lean zip + one-time download.
  const assetPath = path.join(releaseDir, `${variant.key}.onnx`);
  await writeFile(assetPath, bytes);
  console.log(
    `[pack] embedded model ${variant.key} (${(bytes.length / 1e6).toFixed(1)} MB, sha256 verified); ` +
      `asset: ${path.relative(repoRoot, assetPath)}`,
  );
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = pkg.version;
  await mkdir(releaseDir, { recursive: true });

  const files = [];
  for await (const f of walk(distDir)) files.push(f);
  if (!files.length) throw new Error('dist/ is empty — run npm run build first');

  // Lean zip (default).
  const leanZip = path.join(releaseDir, `ai-image-detector-${version}.zip`);
  await zipDir(distDir, leanZip);
  console.log(`[pack] wrote ${path.relative(repoRoot, leanZip)} (${files.length} files)`);

  // Bundled zip (optional): stage into a THROWAWAY copy of dist/ so the lean dist/ and a
  // subsequent lean pack are never polluted with the 311MB model.
  if (withBundled) {
    const stageDir = path.join(releaseDir, `.stage-bundled-${version}`);
    await rm(stageDir, { recursive: true, force: true });
    await cp(distDir, stageDir, { recursive: true });
    try {
      await stageBundledModel(stageDir);
      const bundledZip = path.join(releaseDir, `ai-image-detector-${version}-bundled.zip`);
      await zipDir(stageDir, bundledZip);
      console.log(`[pack] wrote ${path.relative(repoRoot, bundledZip)} (with embedded model)`);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('[pack] FAILED:', err);
  process.exitCode = 1;
});
