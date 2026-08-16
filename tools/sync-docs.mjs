/**
 * Auto-sync dynamic values (version, test counts, coverage %, benchmark accuracy) into
 * documentation via HTML-comment markers.
 *
 * Usage:
 *   node tools/sync-docs.mjs           # write values into marked placeholders
 *   node tools/sync-docs.mjs --check   # exit non-zero if any doc is stale (for CI)
 *
 * Markers in markdown:  <!-- AUTO:KEY -->value<!-- /AUTO:KEY -->
 * The value between the markers is replaced with the computed value. Keys are computed from the
 * source of truth at sync time (package.json, vitest run, coverage summary, benchmark results).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { balancedAccuracyWithCi } from '../src/shared/metrics.js';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isCheck = process.argv.includes('--check');

/* ------------------------------ value computation ------------------------------ */

async function computeValues() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const values = {};

  // Version from package.json
  values.VERSION = pkg.version;

  // Test counts from a vitest run (JSON reporter for determinism). Use the local vitest binary
  // directly (npx spawn fails on Windows without a shell).
  try {
    const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
    const { stdout } = await run(process.execPath, [vitestBin, 'run', '--reporter=json'], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      shell: false,
    });
    const json = JSON.parse(stdout.slice(stdout.indexOf('{')));
    values.TEST_COUNT = String(json.numTotalTests ?? 'unknown');
    // numTotalTestSuites counts describe blocks; testResults.length is the file count.
    values.TEST_FILES = String(json.testResults?.length ?? json.numTotalTestFiles ?? 'unknown');
  } catch (err) {
    console.warn('[sync] could not compute test counts:', err?.message);
  }

  // Coverage from the last coverage summary, or by running cover.
  const covSummary = path.join(repoRoot, 'coverage', 'coverage-summary.json');
  try {
    const cov = JSON.parse(await readFile(covSummary, 'utf8'));
    const t = cov.total;
    values.COV_LINES = t?.lines?.pct?.toFixed(1);
    values.COV_BRANCHES = t?.branches?.pct?.toFixed(1);
    values.COV_FUNCS = t?.functions?.pct?.toFixed(1);
  } catch {
    console.warn('[sync] no coverage-summary.json — run npm run cover first');
  }

  // Benchmark accuracy from the canonical result files. BA_RAW and BA_AUGMENTED are the SHIPPED
  // pipeline (single-view + forensic fusion + Platt calibration), measured by the definitive
  // full-set runs (single-full-final = 471 raw, single-aug-final = 1413 augmented).
  // BA_RAW_UNCALIBRATED keeps the raw neural score (no calibration) for the calibration-quality
  // discussion in BENCHMARK.md.
  values.BA_RAW = await latestBa('haywoodsloan-int8__single-full-final.jsonl');
  values.BA_RAW_UNCALIBRATED = await latestBa('haywoodsloan-int8__single-full.jsonl');
  values.BA_AUGMENTED = await latestBa('haywoodsloan-int8__single-aug-final.jsonl');

  // Whole-line shields.io accuracy badge (kept in sync with BA_RAW). The label encodes % as %25.
  if (values.BA_RAW) {
    const num = values.BA_RAW.replace('%', ''); // e.g. "84.5"
    values.BA_BADGE = `[![Balanced accuracy: ${values.BA_RAW}](https://img.shields.io/badge/balanced%20accuracy-${num}%25-success)](docs/BENCHMARK.md)`;
  }

  return values;
}

async function latestBa(fileName) {
  try {
    const file = path.join(repoRoot, 'bench', 'results', fileName);
    const rows = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const m = balancedAccuracyWithCi(rows, 0.65);
    return `${(m.balancedAccuracy * 100).toFixed(1)}%`;
  } catch {
    return null;
  }
}

/* ------------------------------ marker replacement ------------------------------ */

const MARKER_RE = /<!--\s*AUTO:([A-Z0-9_]+)\s*-->([\s\S]*?)<!--\s*\/AUTO:\1\s*-->/g;

async function syncFile(file, values, { check }) {
  const full = path.join(repoRoot, file);
  let content;
  try {
    content = await readFile(full, 'utf8');
  } catch {
    return { file, changed: false, missing: true };
  }
  let changed = false;
  const missing = [];
  const next = content.replace(MARKER_RE, (match, key, oldValue) => {
    const value = values[key];
    if (value == null) {
      missing.push(key);
      return match;
    }
    if (oldValue !== value) {
      changed = true;
      return `<!-- AUTO:${key} -->${value}<!-- /AUTO:${key} -->`;
    }
    return match;
  });
  if (changed && !check) await writeFile(full, next, 'utf8');
  return { file, changed, missing };
}

/** All markdown docs that may carry markers. */
async function docFiles() {
  const out = [];
  for (const f of await readdir(repoRoot)) {
    if (f.endsWith('.md')) out.push(f);
  }
  const docsDir = path.join(repoRoot, 'docs');
  try {
    for (const f of await readdir(docsDir)) {
      if (f.endsWith('.md')) out.push(path.join('docs', f));
    }
  } catch {
    /* no docs dir */
  }
  return out;
}

async function main() {
  const values = await computeValues();
  console.log('[sync] computed values:', JSON.stringify(values, null, 0));

  const files = await docFiles();
  let anyStale = false;
  let markedFiles = 0;
  for (const file of files) {
    const res = await syncFile(file, values, { check: isCheck });
    if (res.missing === false) continue;
    const raw = await readFile(path.join(repoRoot, file), 'utf8');
    if (!MARKER_RE.test(raw)) continue; // no markers in this file
    MARKER_RE.lastIndex = 0;
    markedFiles++;
    if (res.changed) {
      anyStale = true;
      console.log(`[sync] ${isCheck ? 'STALE' : 'updated'}: ${file}`);
    }
  }

  console.log(`[sync] scanned ${files.length} docs; ${markedFiles} have AUTO markers`);
  if (isCheck && anyStale) {
    console.error('[sync] FAIL: docs are stale. Run `node tools/sync-docs.mjs` and commit.');
    process.exitCode = 1;
  } else {
    console.log(isCheck ? '[sync] OK: all marked docs current' : '[sync] done');
  }
}

main().catch((err) => {
  console.error('[sync] FAILED:', err);
  process.exitCode = 1;
});
