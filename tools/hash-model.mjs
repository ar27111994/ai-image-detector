/**
 * Print the SHA-256 of a local model file for pinning into bench/models.json or
 * models/manifest.json.
 * Usage: node tools/hash-model.mjs <file.onnx>
 */
import { sha256File } from '../bench/model-loader.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/hash-model.mjs <file>');
  process.exit(1);
}
console.log(await sha256File(file));
