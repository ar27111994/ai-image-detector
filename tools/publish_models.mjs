/**
 * Publish model artifacts to a GitHub Release and regenerate models/manifest.json with pinned
 * URLs + SHA-256 hashes.
 *
 * Usage:
 *   node tools/publish_models.mjs --tag models-v1 --asset wkaandemir=models-cache/wkaandemir-int8.onnx \
 *        --variant-key primary-int8 --input-size 256 --mean 0.485,0.456,0.406 --std 0.229,0.224,0.225 \
 *        --output-type p_real
 *
 * Requires: gh CLI authenticated. Idempotent (gh release create/upload clobber).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256File } from '../bench/model-loader.mjs';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { tag: 'models-v1', assets: [], repo: null };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i].replace(/^--/, '');
    const eq = token.indexOf('=');
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (key === 'asset')
      args.assets.push(value); // "name=path"
    else args[key] = value;
  }
  return args;
}

async function gh(args, { capture = true } = {}) {
  return await run('gh', args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, shell: false }).then(
    ({ stdout }) => (capture ? stdout.trim() : undefined),
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.assets.length) throw new Error('at least one --asset name=path is required');

  const repo =
    args.repo ?? (await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']));
  console.log(`[publish] repo=${repo} tag=${args.tag}`);

  // Ensure the release exists.
  try {
    await gh(['release', 'view', args.tag, '--repo', repo]);
    console.log('[publish] release exists');
  } catch {
    console.log('[publish] creating release');
    await gh([
      'release',
      'create',
      args.tag,
      '--repo',
      repo,
      '--title',
      `Model weights ${args.tag}`,
      '--notes',
      'Pre-trained ONNX weights for the AI Image Detector extension. Downloaded once at first-run setup; SHA-256 pinned in models/manifest.json.',
    ]);
  }

  const variants = [];
  for (const asset of args.assets) {
    const eq = asset.indexOf('=');
    const name = asset.slice(0, eq);
    const file = path.resolve(asset.slice(eq + 1));
    const sha256 = await sha256File(file);
    const stat = await (await import('node:fs/promises')).stat(file);
    console.log(
      `[publish] uploading ${name}: ${path.basename(file)} (${(stat.size / 1e6).toFixed(1)} MB) sha256=${sha256.slice(0, 12)}…`,
    );
    await gh(['release', 'upload', args.tag, file, '--repo', repo, '--clobber'], {
      capture: false,
    });
    variants.push({ name, file: path.basename(file), sha256, sizeBytes: stat.size });
  }

  // Emit a manifest fragment AND merge url/sha256/sizeBytes into models/manifest.json so the
  // committed manifest always matches the published assets (no manual step, no stale pins).
  const fragment = variants.map((v) => ({
    key: v.name,
    url: `https://github.com/${repo}/releases/download/${args.tag}/${v.file}`,
    sha256: v.sha256,
    sizeBytes: v.sizeBytes,
  }));

  const { readFile } = await import('node:fs/promises');
  const manifestPath = path.join(repoRoot, 'models', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.releaseTag = args.tag;
  let merged = 0;
  for (const v of fragment) {
    const existing = manifest.variants.find((x) => x.key === v.key);
    if (existing) {
      existing.url = v.url;
      existing.sha256 = v.sha256;
      existing.sizeBytes = v.sizeBytes;
      merged++;
    } else {
      console.warn(
        `[publish] NOTE: variant '${v.key}' not in manifest.json — add its metadata (inputSize/mean/std/labels/license) manually, then re-run to pin.`,
      );
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(
    `[publish] updated models/manifest.json (${merged} variant(s) pinned to tag ${args.tag})`,
  );
  console.log('[publish] fragment (for reference):');
  console.log(JSON.stringify(fragment, null, 2));
}

main().catch((err) => {
  console.error('[publish] FAILED:', err);
  process.exitCode = 1;
});
