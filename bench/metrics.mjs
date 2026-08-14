/**
 * Benchmark metrics report.
 *
 * Usage:
 *   node bench/metrics.mjs --results bench/results/<file>.jsonl [--threshold 0.65]
 *   node bench/metrics.mjs --results a.jsonl,b.jsonl --ensemble   (mean score per image id)
 *   node bench/metrics.mjs --results f.jsonl --sweep
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { balancedAccuracyWithCi, perGroupMetrics, thresholdSweep } from '../src/shared/metrics.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { results: null, threshold: 0.65, ensemble: false, sweep: false };
  const flags = new Set(['ensemble', 'sweep']);
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i].replace(/^--/, '');
    const eq = token.indexOf('=');
    const key = eq >= 0 ? token.slice(0, eq) : token;
    if (flags.has(key)) {
      args[key] = true;
      continue;
    }
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (key in args) args[key] = key === 'threshold' ? Number(value) : value;
  }
  if (!args.results) throw new Error('--results <file.jsonl[,file2.jsonl,...]> is required');
  return args;
}

async function loadResults(files) {
  const rows = [];
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.join(repoRoot, file);
    const text = await readFile(abs, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}

/** Average scores for identical image ids across result files (model ensembling). */
function ensembleMean(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, { ...row, scores: [] });
    }
    if (row.score != null && !row.error) byId.get(row.id).scores.push(row.score);
  }
  const out = [];
  for (const entry of byId.values()) {
    if (entry.scores.length === 0) {
      out.push({ ...entry, score: null, error: entry.error ?? 'all models failed' });
    } else {
      const score = entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length;
      out.push({ ...entry, score, scores: undefined });
    }
  }
  return out;
}

function pct(x) {
  return `${(x * 100).toFixed(2)}%`;
}

function printRow(label, m) {
  console.log(
    `  ${label.padEnd(28)} BA=${pct(m.balancedAccuracy)}  TPR=${pct(m.tpr)}  TNR=${pct(m.tnr)}  ` +
      `n=${m.positives}+${m.negatives}  err=${m.errors}`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  let rows = await loadResults(args.results.split(','));
  if (args.ensemble) rows = ensembleMean(rows);

  const scored = rows.filter((r) => r.score != null && !r.error);
  console.log(`\n== Metrics @ threshold ${args.threshold} ==`);
  console.log(
    `rows: ${rows.length}  scored: ${scored.length}  errors: ${rows.length - scored.length}`,
  );

  const overall = balancedAccuracyWithCi(rows, args.threshold);
  printRow('ALL', overall);
  console.log(`  95% CI: [${pct(overall.ci95[0])}, ${pct(overall.ci95[1])}]`);

  const raw = rows.filter((r) => !r.augmented);
  const augmented = rows.filter((r) => r.augmented);
  if (raw.length && augmented.length) {
    console.log('\n-- by split --');
    printRow('raw', balancedAccuracyWithCi(raw, args.threshold));
    printRow('augmented', balancedAccuracyWithCi(augmented, args.threshold));
    for (const kind of [...new Set(augmented.map((r) => r.augmented))]) {
      printRow(
        `  ${kind}`,
        balancedAccuracyWithCi(
          augmented.filter((r) => r.augmented === kind),
          args.threshold,
        ),
      );
    }
  }

  console.log('\n-- per generator (fake) / source (real) --');
  const fakeRows = rows.filter((r) => r.label === 'fake');
  const realRows = rows.filter((r) => r.label === 'real');
  for (const g of perGroupMetrics(fakeRows, (r) => r.generator, args.threshold)) {
    console.log(`  fake/${g.group.padEnd(26)} TPR=${pct(g.tpr)}  n=${g.positives}`);
  }
  for (const g of perGroupMetrics(realRows, (r) => r.source, args.threshold)) {
    console.log(`  real/${g.group.padEnd(25)} TNR=${pct(g.tnr)}  n=${g.negatives}`);
  }

  if (args.sweep) {
    console.log('\n-- threshold sweep --');
    const ts = [];
    for (let t = 0.3; t <= 0.9001; t += 0.05) ts.push(Number(t.toFixed(2)));
    for (const row of thresholdSweep(rows, ts)) {
      console.log(
        `  t=${row.threshold.toFixed(2)}  BA=${pct(row.balancedAccuracy)}  TPR=${pct(row.tpr)}  TNR=${pct(row.tnr)}`,
      );
    }
  }

  const PASS_BAR = 0.75;
  const INTERNAL_GATE = 0.8;
  console.log(
    `\nBounty bar (balanced accuracy @ ${args.threshold}): ${pct(PASS_BAR)} -> ` +
      `${overall.balancedAccuracy >= PASS_BAR ? 'PASS' : 'FAIL'}; ` +
      `internal gate ${pct(INTERNAL_GATE)} -> ` +
      `${overall.balancedAccuracy >= INTERNAL_GATE ? 'PASS' : 'FAIL'}`,
  );
  if (overall.balancedAccuracy < PASS_BAR) process.exitCode = 2;
}

main().catch((err) => {
  console.error('[metrics] FAILED:', err);
  process.exitCode = 1;
});
