/**
 * Benchmark dataset fetcher.
 *
 * Downloads a fixed-seed, stratified, balanced image set from public sources and records a
 * manifest (JSONL) of {id, source, label, generator, type, path, width, height}.
 *
 * Sources:
 *   - openfake       ComplexDataLab/OpenFake (validation + test): modern generators
 *                    (flux*, midjourney-*, imagen-*, sd-3.5, sdxl, gpt-image, grok, ...) + reals
 *                    (laion, pexels, imagenet). Rows served via HF datasets-server.
 *   - openfaketiny   ComplexDataLab/OpenFakeTiny (test + validation): 1.2K-row curated subset.
 *   - coco           COCO val2017 direct image URLs (real photos, fixed-seed sample).
 *
 * Resumable: files already on disk are skipped; re-running with the same args continues.
 *
 * Usage:
 *   node bench/fetch-dataset.mjs --real 400 --fake 400 --seed 1337
 *   node bench/fetch-dataset.mjs --source openfake --fake 250
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seededShuffle } from '../src/shared/rng.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(repoRoot, 'bench', 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.jsonl');

const ROWS_API = 'https://datasets-server.huggingface.co/rows';
const ROWS_PAGE = 100; // datasets-server max page size

/** OpenFake row `type` values that are still images (video frames are exported as images too). */
const SKIP_ROW_TYPES = new Set(['video']); // video frames look different from web images

/** Generators we treat as "AI" vs "real" source labels come from the row `label` field. */

function parseArgs(argv) {
  const args = { real: 400, fake: 400, seed: 1337, source: null };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i].replace(/^--/, '');
    const eq = token.indexOf('=');
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (key in args) args[key] = key === 'source' ? value : Number(value);
  }
  for (const numKey of ['real', 'fake', 'seed']) {
    if (!Number.isFinite(args[numKey])) {
      throw new Error(`invalid numeric value for --${numKey}`);
    }
  }
  return args;
}

async function fetchJson(url, { retries = 4, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'ai-detector-bench/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr ?? new Error(`fetch failed: ${url}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Download a URL to disk; skip if present. Returns { file, skipped }. */
async function downloadToFile(url, filePath) {
  try {
    await stat(filePath);
    return { skipped: true };
  } catch {
    /* not cached yet */
  }
  const res = await fetch(url, {
    headers: { 'user-agent': 'ai-detector-bench/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.part`;
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(tmp);
    res.body
      .pipeTo(
        new WritableStream({
          write: (chunk) => new Promise((r2) => ws.write(chunk, r2)),
          close: () => ws.end(resolve),
          abort: reject,
        }),
      )
      .catch(reject);
  });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, filePath);
  return { skipped: false };
}

/** Load existing manifest ids so re-runs are resumable. */
async function loadExistingIds() {
  try {
    const text = await readFile(MANIFEST_PATH, 'utf8');
    return new Set(
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).id),
    );
  } catch {
    return new Set();
  }
}

async function appendManifest(entries) {
  await mkdir(DATA_DIR, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const { appendFile } = await import('node:fs/promises');
  await appendFile(MANIFEST_PATH, lines, 'utf8');
}

/** Deterministic page offsets covering [0, totalRows). */
function pageOffsets(totalRows, seed) {
  const pages = Math.ceil(totalRows / ROWS_PAGE);
  const order = seededShuffle(
    Array.from({ length: pages }, (_, i) => i),
    seed,
  );
  return order.map((p) => p * ROWS_PAGE);
}

/**
 * Stratified sampler for an HF rows-API dataset with `label` and `model` fields.
 * Walks pages in seeded order; buckets rows by generator; enforces a per-generator cap so a
 * single generator cannot dominate the sample.
 */
async function sampleHfDataset({
  dataset,
  configs, // [{config, split}]
  wanted, // { real: n, fake: n }
  perGeneratorCap,
  seed,
  sourceTag,
  existingIds,
  outDir,
  maxPages = 400,
  mapRow = null, // optional override: (row) => { label, generator, type }
}) {
  const picked = [];
  const generatorCounts = new Map();
  const labelCounts = { real: 0, fake: 0 };

  for (const { config, split } of configs) {
    const splitInfo = await fetchJson(
      `${ROWS_API}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=0&length=0`,
    ).catch(() => null);
    const total = splitInfo?.num_rows_total ?? 0;
    if (!total) continue;

    for (const offset of pageOffsets(total, seed)) {
      if (maxPages-- <= 0) break;
      if (labelCounts.real >= wanted.real && labelCounts.fake >= wanted.fake) break;

      let page;
      try {
        page = await fetchJson(
          `${ROWS_API}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${ROWS_PAGE}`,
        );
      } catch (err) {
        console.warn(`[fetch] ${sourceTag} page @${offset} failed: ${err.message}`);
        continue;
      }
      const rows = seededShuffle(page.rows ?? [], seed + offset);
      process.stdout.write(
        `\r[fetch] ${sourceTag}/${split} @${offset}: real=${labelCounts.real}/${wanted.real} fake=${labelCounts.fake}/${wanted.fake}   `,
      );

      // Select eligible rows synchronously, then download with bounded concurrency.
      const candidates = [];
      for (const { row_idx: rowIdx, row } of rows) {
        const mapped = mapRow
          ? mapRow(row)
          : {
              label: row.label === 'fake' ? 'fake' : 'real',
              generator: String(row.model ?? 'unknown'),
              type: String(row.type ?? ''),
            };
        const { label, generator, type } = mapped;
        if (labelCounts[label] >= wanted[label]) continue;
        if (SKIP_ROW_TYPES.has(String(type).toLowerCase())) continue;
        const gCount = generatorCounts.get(generator) ?? 0;
        if (gCount >= perGeneratorCap) continue;
        const img = row.image;
        if (!img?.src) continue;

        const id = `${sourceTag}-${split}-${offset + rowIdx}`;
        if (existingIds.has(id)) continue;

        candidates.push({ id, label, generator, type, img });
        generatorCounts.set(generator, gCount + 1);
        labelCounts[label]++;
        if (labelCounts.real >= wanted.real && labelCounts.fake >= wanted.fake) break;
      }

      const DOWNLOAD_CONCURRENCY = 8;
      const queue = candidates.slice();
      async function downloadWorker() {
        while (queue.length) {
          const c = queue.shift();
          const ext = extFromUrl(c.img.src) || '.jpg';
          const file = path.join(outDir, sourceTag, c.label, `${c.id}${ext}`);
          try {
            await downloadToFile(c.img.src, file);
          } catch (err) {
            console.warn(`\n[fetch] skip ${c.id}: ${err.message}`);
            continue;
          }
          picked.push({
            id: c.id,
            source: sourceTag,
            label: c.label,
            generator: c.generator,
            type: c.type,
            path: path.relative(repoRoot, file),
            width: c.img.width ?? 0,
            height: c.img.height ?? 0,
          });
        }
      }
      await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, downloadWorker));
    }
  }
  return picked;
}

function extFromUrl(url) {
  const m = url.match(/\.(jpg|jpeg|png|webp|gif|avif)(?:[?&]|$)/i);
  return m ? `.${m[1].toLowerCase()}` : null;
}

/**
 * COCO val split served via HF datasets-server (sayakpaul/coco-30-val-2014: 30K real photos
 * with captions; cached-assets URLs). These predate generative AI — canonical "real" class.
 */
async function sampleCoco({ wanted, seed, existingIds, outDir }) {
  return sampleHfDataset({
    dataset: 'sayakpaul/coco-30-val-2014',
    configs: [{ config: 'default', split: 'train' }],
    wanted: { real: wanted, fake: 0 },
    perGeneratorCap: Number.MAX_SAFE_INTEGER,
    seed,
    sourceTag: 'coco',
    existingIds,
    outDir,
    mapRow: () => ({ label: 'real', generator: 'coco-camera', type: 'photo' }),
  });
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`[fetch] target: real=${args.real} fake=${args.fake} seed=${args.seed}`);
  const existingIds = await loadExistingIds();
  console.log(`[fetch] resuming with ${existingIds.size} existing entries`);

  const collected = [];

  if (!args.source || args.source === 'openfake') {
    const fakeFromOpenFake = Math.ceil(args.fake * 0.75);
    const realFromOpenFake = Math.ceil(args.real * 0.45);
    console.log(`[fetch] openfake: real=${realFromOpenFake} fake=${fakeFromOpenFake}`);
    collected.push(
      ...(await sampleHfDataset({
        dataset: 'ComplexDataLab/OpenFake',
        configs: [
          { config: 'core', split: 'validation' },
          { config: 'core', split: 'test' },
        ],
        wanted: { real: realFromOpenFake, fake: fakeFromOpenFake },
        perGeneratorCap: 20,
        seed: args.seed,
        sourceTag: 'openfake',
        existingIds,
        outDir: path.join(DATA_DIR, 'images'),
      })),
    );
  }

  if (!args.source || args.source === 'openfaketiny') {
    const fakeFromTiny = Math.ceil(args.fake * 0.25);
    const realFromTiny = Math.ceil(args.real * 0.15);
    console.log(`[fetch] openfaketiny: real=${realFromTiny} fake=${fakeFromTiny}`);
    collected.push(
      ...(await sampleHfDataset({
        dataset: 'ComplexDataLab/OpenFakeTiny',
        configs: [
          { config: 'core', split: 'test' },
          { config: 'core', split: 'validation' },
        ],
        wanted: { real: realFromTiny, fake: fakeFromTiny },
        perGeneratorCap: 12,
        seed: args.seed + 1,
        sourceTag: 'openfaketiny',
        existingIds,
        outDir: path.join(DATA_DIR, 'images'),
      })),
    );
  }

  if (!args.source || args.source === 'coco') {
    const realFromCoco = Math.max(
      0,
      args.real - collected.filter((e) => e.label === 'real').length,
    );
    console.log(`[fetch] coco: real=${realFromCoco}`);
    if (realFromCoco > 0) {
      collected.push(
        ...(await sampleCoco({
          wanted: realFromCoco,
          seed: args.seed + 2,
          existingIds,
          outDir: path.join(DATA_DIR, 'images'),
        })),
      );
    }
  }

  if (collected.length) await appendManifest(collected);
  const real = collected.filter((e) => e.label === 'real').length;
  const fake = collected.filter((e) => e.label === 'fake').length;
  console.log(`[fetch] added ${collected.length} (real=${real} fake=${fake})`);
  console.log(`[fetch] manifest: ${path.relative(repoRoot, MANIFEST_PATH)}`);

  const generators = new Map();
  for (const e of collected) generators.set(e.generator, (generators.get(e.generator) ?? 0) + 1);
  const top = [...generators.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('[fetch] top generators:', top.map(([g, c]) => `${g}=${c}`).join(', '));
}

main().catch((err) => {
  console.error('[fetch] FAILED:', err);
  process.exitCode = 1;
});
