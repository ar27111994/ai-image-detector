/**
 * Validate models/manifest.json: structure, integrity pins, and per-variant shape.
 *
 * Exits non-zero on any violation. The CI build job already asserts each variant carries a
 * 64-hex SHA-256 pin and a URL; this tool is the deeper, shareable validator behind
 * `npm run models:manifest`.
 *
 * Usage: node tools/verify-manifest.mjs [path-to-manifest]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = path.join(repoRoot, 'models', 'manifest.json');

const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Validate a parsed manifest object, returning a list of problems (empty = valid).
 * Pure and exported for tests.
 * @param {*} manifest parsed JSON
 * @returns {string[]} human-readable violations
 */
export function validateManifest(manifest) {
  const problems = [];
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest is not a JSON object'];
  }
  if (!Array.isArray(manifest.variants) || manifest.variants.length === 0) {
    problems.push('manifest.variants must be a non-empty array');
    return problems; // nothing else to check
  }
  const seenKeys = new Set();
  manifest.variants.forEach((v, i) => {
    const where = `variants[${i}]`;
    if (v == null || typeof v !== 'object') {
      problems.push(`${where}: not an object`);
      return;
    }
    if (typeof v.key !== 'string' || !v.key) problems.push(`${where}: missing/invalid key`);
    else if (seenKeys.has(v.key)) problems.push(`${where}: duplicate key '${v.key}'`);
    else seenKeys.add(v.key);
    if (typeof v.kind !== 'string' || !['wasm', 'webgpu'].includes(v.kind)) {
      problems.push(`${where}: kind must be 'wasm' | 'webgpu' (got ${JSON.stringify(v.kind)})`);
    }
    if (typeof v.url !== 'string' || !/^https:\/\//.test(v.url)) {
      problems.push(`${where}: url must be an https URL (got ${JSON.stringify(v.url)})`);
    }
    if (typeof v.sha256 !== 'string' || !SHA256_RE.test(v.sha256)) {
      problems.push(`${where}: sha256 must be 64 hex chars`);
    }
    // sizeBytes is MANDATORY: the download path computes its hard cap as `(sizeBytes ?? 0) + 1MB`,
    // so a variant accepted without it would cap the download at 1MB and reject any normal model
    // during setup. Always require a positive integer.
    if (!Number.isInteger(v.sizeBytes) || v.sizeBytes <= 0) {
      problems.push(`${where}: sizeBytes is required and must be a positive integer`);
    }
    if (!Number.isInteger(v.inputSize) || v.inputSize <= 0) {
      problems.push(`${where}: inputSize must be a positive integer`);
    }
    if (!Array.isArray(v.mean) || v.mean.length !== 3 || !v.mean.every(Number.isFinite)) {
      problems.push(`${where}: mean must be [r,g,b] numbers`);
    }
    if (
      !Array.isArray(v.std) ||
      v.std.length !== 3 ||
      !v.std.every((n) => Number.isFinite(n) && n > 0)
    ) {
      problems.push(`${where}: std must be [r,g,b] positive numbers`);
    }
    // Output semantics drive scoring (scoreFromOutput): an unrecognized outputType falls through to
    // 2-class logits, and an out-of-range aiLogitIndex reads a nonexistent logit -> garbage score.
    if (v.outputType != null && !['logits', 'p_real'].includes(v.outputType)) {
      problems.push(
        `${where}: outputType must be 'logits' | 'p_real' (got ${JSON.stringify(v.outputType)})`,
      );
    }
    const isLogits = (v.outputType ?? 'logits') === 'logits';
    if (isLogits && v.aiLogitIndex != null && ![0, 1].includes(v.aiLogitIndex)) {
      problems.push(
        `${where}: aiLogitIndex must be 0 or 1 for logits variants (got ${v.aiLogitIndex})`,
      );
    }
  });
  return problems;
}

async function main() {
  const file = path.resolve(process.argv[2] ?? DEFAULT_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    console.error(`[verify-manifest] cannot read ${path.relative(repoRoot, file)}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const problems = validateManifest(manifest);
  if (problems.length) {
    console.error(
      `[verify-manifest] ${problems.length} problem(s) in ${path.relative(repoRoot, file)}:`,
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[verify-manifest] OK: ${manifest.variants.length} variant(s), all SHA-256 pinned.`);
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
