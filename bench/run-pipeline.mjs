/**
 * End-to-end pipeline benchmark: runs the FULL detection stack (forensic metadata -> neural
 * inference -> calibrated fusion) exactly as the shipped extension does, and reports balanced
 * accuracy. This is the number that must clear the 75% bar.
 *
 * Unlike bench/run.mjs (raw neural score only), this applies:
 *   - forensic definitive short-circuit (metadata signatures => 0.99)
 *   - Platt calibration (src/shared/fusion/calibration.js)
 *   - camera-EXIF nudge
 *
 * Usage: node bench/run-pipeline.mjs --model haywoodsloan-int8 [--only raw|augmented] [--tag x]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { preprocessRgba } from '../src/shared/preprocess.js';
import { extractForensicSignals } from '../src/shared/metadata/forensic-extractor.js';
import { fuseSignals } from '../src/shared/fusion/fuse.js';
import { resolveModel } from './model-loader.mjs';
import { balancedAccuracyWithCi } from '../src/shared/metrics.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(repoRoot, 'bench', 'data');
const RESULTS_DIR = path.join(repoRoot, 'bench', 'results');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.jsonl');

function parseArgs(argv) {
  const args = { model: null, only: 'all', tag: 'pipeline', threshold: 0.65, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i].replace(/^--/, '');
    const eq = token.indexOf('=');
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (key in args)
      args[key] = ['limit'].includes(key)
        ? Number(value)
        : key === 'threshold'
          ? Number(value)
          : value;
  }
  if (!args.model) throw new Error('--model required');
  return args;
}

async function loadManifest() {
  const text = await readFile(MANIFEST_PATH, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function main() {
  const args = parseArgs(process.argv);
  const { name, file, spec } = await resolveModel(args.model);
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(file, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 4,
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  let entries = await loadManifest();
  if (args.only === 'raw') entries = entries.filter((e) => !e.augmented);
  if (args.only === 'augmented') entries = entries.filter((e) => e.augmented);
  if (args.limit > 0) entries = entries.slice(0, args.limit);

  console.log(`[pipeline] ${entries.length} images, model=${name}`);
  const results = [];
  let done = 0;
  const t0 = Date.now();

  for (const entry of entries) {
    const abs = path.join(repoRoot, entry.path);
    try {
      const bytes = await readFile(abs);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const forensic = await extractForensicSignals(buffer);

      let neuralScore = 0.5;
      if (!forensic.definitive) {
        const { data, info } = await sharp(abs, { failOn: 'none' })
          .flatten({ background: '#ffffff' })
          .raw()
          .ensureAlpha()
          .toBuffer({ resolveWithObject: true });
        const tensor = preprocessRgba(
          new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
          info.width,
          info.height,
          spec,
        );
        const out = await session.run({
          [inputName]: new ort.Tensor('float32', tensor.data, tensor.dims),
        });
        const output = Array.from(out[outputName].data);
        neuralScore =
          spec.outputType === 'p_real'
            ? 1 - output[0]
            : Math.exp(output[spec.aiLogitIndex ?? 1]) /
              (Math.exp(output[0]) + Math.exp(output[1]));
      }

      const fused = fuseSignals({ neuralScore, forensic }, { threshold: args.threshold });
      results.push({
        id: entry.id,
        label: entry.label,
        generator: entry.generator,
        augmented: entry.augmented ?? null,
        score: fused.score,
        neuralScore,
        forensicDefinitive: forensic.definitive,
        verdict: fused.verdict,
      });
    } catch (err) {
      results.push({
        id: entry.id,
        label: entry.label,
        error: String(err?.message ?? err),
        score: null,
      });
    }
    if (++done % 25 === 0) {
      console.log(
        `[pipeline] ${done}/${entries.length} (${(done / ((Date.now() - t0) / 1000)).toFixed(1)}/s)`,
      );
    }
  }

  await writeFile(
    path.join(RESULTS_DIR, `${name}__${args.tag}.jsonl`),
    results.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );

  const m = balancedAccuracyWithCi(results, args.threshold);
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  console.log(`\n== Pipeline metrics @ ${args.threshold} ==`);
  console.log(
    `BA=${pct(m.balancedAccuracy)}  TPR=${pct(m.tpr)}  TNR=${pct(m.tnr)}  n=${m.positives}+${m.negatives}  err=${m.errors}`,
  );
  console.log(`95% CI: [${pct(m.ci95[0])}, ${pct(m.ci95[1])}]`);
  const forensicCaught = results.filter((r) => r.forensicDefinitive && r.label === 'fake').length;
  console.log(`forensic definitive hits (fake): ${forensicCaught}`);
  const raw = results.filter((r) => !r.augmented);
  const aug = results.filter((r) => r.augmented);
  if (raw.length && aug.length) {
    console.log(
      `raw: BA=${pct(balancedAccuracyWithCi(raw, args.threshold).balancedAccuracy)}  augmented: BA=${pct(balancedAccuracyWithCi(aug, args.threshold).balancedAccuracy)}`,
    );
  }
  console.log(
    `\nbar: ${pct(0.75)} -> ${m.balancedAccuracy >= 0.75 ? 'PASS' : 'FAIL'}; internal gate 80% -> ${m.balancedAccuracy >= 0.8 ? 'PASS' : 'FAIL'}`,
  );
}

main().catch((err) => {
  console.error('[pipeline] FAILED:', err);
  process.exitCode = 1;
});
