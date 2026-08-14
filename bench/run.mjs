/**
 * Benchmark runner: scores every manifest image with an ONNX model via onnxruntime-node,
 * using the SHARED preprocessing pipeline (src/shared/preprocess.js) the extension uses.
 *
 * Usage:
 *   node bench/run.mjs --model vit-deepfake-int8 [--limit 100] [--only raw|augmented]
 *                      [--concurrency 4] [--tag myrun]
 *
 * Output: bench/results/<model>__<tag|date>.jsonl with per-image
 *   { id, label, source, generator, augmented, score, latencyMs, error? }
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { aiProbability, preprocessRgba } from '../src/shared/preprocess.js';
import { resolveModel } from './model-loader.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(repoRoot, 'bench', 'data');
const RESULTS_DIR = path.join(repoRoot, 'bench', 'results');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.jsonl');

function parseArgs(argv) {
  const args = { model: null, limit: 0, only: 'all', concurrency: 4, tag: null };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i].replace(/^--/, '');
    const eq = token.indexOf('=');
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (key in args) args[key] = ['limit', 'concurrency'].includes(key) ? Number(value) : value;
  }
  if (!args.model) throw new Error('--model <registry-name|path.onnx> is required');
  return args;
}

async function loadManifest() {
  const text = await readFile(MANIFEST_PATH, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Decode any image format to raw RGBA via sharp, then run the shared pipeline. */
async function decodeAndPreprocess(filePath, spec) {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .flatten({ background: '#ffffff' }) // match canvas compositing of transparent PNGs
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  return preprocessRgba(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
    spec,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const { name, file, spec } = await resolveModel(args.model);

  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(file, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Math.max(1, Math.min(4, args.concurrency)),
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  console.log(`[bench] model=${name} input=${inputName} output=${outputName}`);

  let entries = await loadManifest();
  if (args.only === 'raw') entries = entries.filter((e) => !e.augmented);
  if (args.only === 'augmented') entries = entries.filter((e) => e.augmented);
  if (args.limit > 0) entries = entries.slice(0, args.limit);

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = args.tag ?? new Date().toISOString().slice(0, 10);
  const outPath = path.join(RESULTS_DIR, `${name}__${stamp}.jsonl`);
  const outLines = [];

  let done = 0;
  const started = Date.now();
  const queue = entries.slice();

  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      const absPath = path.join(repoRoot, entry.path);
      const t0 = performance.now();
      try {
        const tensor = await decodeAndPreprocess(absPath, spec);
        const feeds = {
          [inputName]: new ort.Tensor('float32', tensor.data, tensor.dims),
        };
        const results = await session.run(feeds);
        const output = results[outputName].data;
        // Two model output conventions are supported:
        //  - 2-class logits + aiLogitIndex (softmax)      [dima806, Ateeqq]
        //  - outputType 'p_real': calibrated p(real) scalar (temperature+sigmoid baked in),
        //    so AI probability = 1 - p_real               [wkaandemir]
        const score =
          spec.outputType === 'p_real' ? 1 - output[0] : aiProbability(output, spec.aiLogitIndex);
        outLines.push(
          JSON.stringify({
            id: entry.id,
            label: entry.label,
            source: entry.source,
            generator: entry.generator,
            augmented: entry.augmented ?? null,
            score,
            latencyMs: Math.round(performance.now() - t0),
          }),
        );
      } catch (err) {
        outLines.push(
          JSON.stringify({
            id: entry.id,
            label: entry.label,
            source: entry.source,
            generator: entry.generator,
            augmented: entry.augmented ?? null,
            score: null,
            error: String(err?.message ?? err),
            latencyMs: Math.round(performance.now() - t0),
          }),
        );
      }
      done++;
      if (done % 25 === 0) {
        const rate = (done / ((Date.now() - started) / 1000)).toFixed(1);
        console.log(`[bench] ${done}/${entries.length} (${rate}/s)`);
      }
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, worker));
  await writeFile(outPath, outLines.join('\n') + '\n', 'utf8');
  const errors = outLines.filter((l) => JSON.parse(l).error).length;
  console.log(
    `[bench] done: ${entries.length} images in ${((Date.now() - started) / 1000).toFixed(0)}s, ` +
      `${errors} errors -> ${path.relative(repoRoot, outPath)}`,
  );
}

main().catch((err) => {
  console.error('[bench] FAILED:', err);
  process.exitCode = 1;
});
