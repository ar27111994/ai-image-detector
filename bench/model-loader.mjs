/**
 * Model artifact loader for the benchmark harness: downloads ONNX files to models-cache/
 * with optional SHA-256 verification (when the registry entry has one pinned).
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(repoRoot, 'models-cache');
const REGISTRY_PATH = path.join(repoRoot, 'bench', 'models.json');

export async function loadRegistry() {
  const raw = await readFile(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw).models;
}

export async function sha256File(filePath) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = createReadStream(filePath);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * Resolve a model name (registry key) or a direct file path to a local ONNX file + spec.
 * @param {string} nameOrPath
 * @returns {Promise<{ name: string, file: string, spec: object }>}
 */
export async function resolveModel(nameOrPath) {
  const registry = await loadRegistry();
  const spec = registry[nameOrPath];

  if (!spec) {
    // Treat as a local path.
    const file = path.resolve(nameOrPath);
    await stat(file);
    return {
      name: path.basename(file, '.onnx'),
      file,
      spec: { inputSize: 224, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], aiLogitIndex: 1 },
    };
  }

  const url = new URL(spec.url);
  const fileName = `${nameOrPath}-${path.basename(url.pathname)}`;
  const file = path.join(CACHE_DIR, fileName);

  try {
    await stat(file);
  } catch {
    console.log(`[model] downloading ${nameOrPath} from ${spec.url}`);
    await mkdir(CACHE_DIR, { recursive: true });
    const res = await fetch(spec.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading model ${nameOrPath}`);
    const tmp = `${file}.part`;
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
    await rename(tmp, file);
    console.log(`[model] cached at ${path.relative(repoRoot, file)}`);
  }

  if (spec.sha256) {
    const actual = await sha256File(file);
    if (actual !== spec.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${nameOrPath}: expected ${spec.sha256}, got ${actual}. ` +
          'Delete models-cache entry and retry, or update the pinned hash deliberately.',
      );
    }
    console.log(`[model] sha256 verified for ${nameOrPath}`);
  } else {
    console.warn(`[model] WARNING: no pinned sha256 for ${nameOrPath}; run tools/hash-model.mjs`);
  }

  return { name: nameOrPath, file, spec };
}
