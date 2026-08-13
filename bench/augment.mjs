/**
 * Benchmark augmentation: deterministic web-realistic degradation variants of every
 * non-augmented manifest entry.
 *
 * Variants:
 *   jpeg70   re-encode as JPEG quality 70  (social-media-like recompression)
 *   jpeg85   re-encode as JPEG quality 85
 *   resize50 downscale to 50% (nearest-larger even dims), then re-encode as JPEG q90
 *
 * Augmented entries append to the same manifest with `augmented: <kind>`; the original entry id
 * is kept as `parentId`. Idempotent: existing files/entries are skipped.
 *
 * Usage: node bench/augment.mjs [--kinds jpeg70,jpeg85,resize50]
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(repoRoot, 'bench', 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.jsonl');

const KINDS = {
  jpeg70: (img) => img.jpeg({ quality: 70 }),
  jpeg85: (img) => img.jpeg({ quality: 85 }),
  resize50: (img, meta) =>
    img
      .resize({
        width: Math.max(2, Math.round(meta.width / 2)),
        height: Math.max(2, Math.round(meta.height / 2)),
        fit: 'fill',
      })
      .jpeg({ quality: 90 }),
};

async function loadManifest() {
  const text = await readFile(MANIFEST_PATH, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const kindsArg = process.argv.find((a) => a.startsWith('--kinds='));
  const kinds = kindsArg ? kindsArg.split('=')[1].split(',') : Object.keys(KINDS);
  const entries = await loadManifest();
  const originals = entries.filter((e) => !e.augmented);
  const existingIds = new Set(entries.map((e) => e.id));

  console.log(`[augment] ${originals.length} originals × ${kinds.length} kinds`);
  const added = [];
  let skipped = 0;

  for (const entry of originals) {
    const srcPath = path.join(repoRoot, entry.path);
    for (const kind of kinds) {
      const id = `${entry.id}__${kind}`;
      if (existingIds.has(id)) {
        skipped++;
        continue;
      }
      const outPath = path.join(DATA_DIR, 'images', entry.source, entry.label, `${id}.jpg`);
      try {
        await stat(outPath);
      } catch {
        const pipeline = sharp(srcPath, { failOn: 'none' });
        const meta = await pipeline.metadata();
        await KINDS[kind](pipeline, meta).toFile(outPath);
      }
      added.push({
        id,
        parentId: entry.id,
        source: entry.source,
        label: entry.label,
        generator: entry.generator,
        type: entry.type,
        path: path.relative(repoRoot, outPath),
        width: 0,
        height: 0,
        augmented: kind,
      });
      existingIds.add(id);
    }
  }

  if (added.length) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(MANIFEST_PATH, added.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }
  console.log(`[augment] added=${added.length} skipped(existing)=${skipped}`);
}

main().catch((err) => {
  console.error('[augment] FAILED:', err);
  process.exitCode = 1;
});
