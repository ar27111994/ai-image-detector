/**
 * Pack the built extension (dist/) into a versioned zip for distribution / submission.
 * Usage: npm run build && npm run pack
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const releaseDir = path.join(repoRoot, 'release');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = pkg.version;
  await mkdir(releaseDir, { recursive: true });
  const zipPath = path.join(releaseDir, `ai-image-detector-${version}.zip`);

  // Prefer PowerShell Compress-Archive on Windows; fall back to `tar -a` elsewhere.
  const files = [];
  for await (const f of walk(distDir)) files.push(f);
  if (!files.length) throw new Error('dist/ is empty — run npm run build first');

  try {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ]);
  } catch {
    await run('tar', ['-a', '-c', '-f', zipPath, '-C', distDir, '.']);
  }
  console.log(`[pack] wrote ${path.relative(repoRoot, zipPath)} (${files.length} files)`);
}

main().catch((err) => {
  console.error('[pack] FAILED:', err);
  process.exitCode = 1;
});
