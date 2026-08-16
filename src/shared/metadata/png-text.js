/**
 * PNG textual chunk (tEXt/iTXt/zTXt) decoding + AI-generator signature detection.
 * Pure JS; zTXt/compressed iTXt inflated via DecompressionStream (Chrome 80+, all ext contexts).
 */
import { parsePngChunks } from './containers.js';

/** A1111/Fooocus/Civitai "parameters" value fingerprint. */
const A1111_PARAMS_RE = /(Steps|Sampler|CFG scale|Seed|Model hash|Model)\s*:/i;

/** Generator-identifying software values seen in the wild. */
const AI_SOFTWARE = [
  'novelai',
  'stable diffusion',
  'stablediffusion',
  'midjourney',
  'dall-e',
  'dalle',
  'adobe firefly',
  'dreamstudio',
  'playground ai',
  'leonardo.ai',
  'leonardo ai',
  'ideogram',
  'bing image creator',
  'microsoft designer',
  'imagefx',
  'comfyui',
  'invokeai',
  'fooocus',
];

/**
 * Decode a tEXt chunk: keyword\x00value (latin-1).
 * @param {Uint8Array} data
 * @returns {{ key: string, value: string }|null} null when malformed
 */
function decodeText(data) {
  const nullIdx = data.indexOf(0);
  if (nullIdx === -1) return null;
  const key = new TextDecoder('latin1').decode(data.slice(0, nullIdx));
  const value = new TextDecoder('latin1').decode(data.slice(nullIdx + 1));
  return { key, value };
}

async function inflate(data) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Decode a zTXt chunk: keyword\x00 compression_method(1) compressed_value
 * @param {Uint8Array} data
 * @returns {Promise<{ key: string, value: string|null }|null>} null when malformed
 */
async function decodeZtxt(data) {
  const nullIdx = data.indexOf(0);
  if (nullIdx === -1) return null;
  const key = new TextDecoder('latin1').decode(data.slice(0, nullIdx));
  const method = data[nullIdx + 1];
  if (method !== 0) return { key, value: null }; // unknown method
  const inflated = await inflate(data.slice(nullIdx + 2));
  return { key, value: new TextDecoder('latin1').decode(inflated) };
}

/**
 * Decode an iTXt chunk (utf-8, optional compression).
 * @param {Uint8Array} data
 * @returns {Promise<{ key: string, value: string|null }|null>} null when malformed
 */
async function decodeItxt(data) {
  let i = 0;
  const readNull = () => {
    while (i < data.length && data[i] !== 0) i++;
    return data.slice(0, i++).length ? i : i; // position advance
  };
  // keyword
  let start = 0;
  while (i < data.length && data[i] !== 0) i++;
  const key = new TextDecoder('utf-8').decode(data.slice(start, i));
  i++; // null
  if (i + 2 > data.length) return { key, value: null };
  const compressionFlag = data[i++];
  const compressionMethod = data[i++];
  readNull(); // language tag
  start = i;
  while (i < data.length && data[i] !== 0) i++;
  i++; // translated keyword
  let value;
  if (compressionFlag === 1 && compressionMethod === 0) {
    const inflated = await inflate(data.slice(i));
    value = new TextDecoder('utf-8').decode(inflated);
  } else {
    value = new TextDecoder('utf-8').decode(data.slice(i));
  }
  return { key, value };
}

/**
 * Extract all textual chunks (tEXt / iTXt / zTXt) from PNG bytes.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<Array<{ key: string, value: string|null }>>} key/value pairs (corrupt
 *   chunks are skipped, never thrown)
 */
export async function extractPngText(buffer) {
  const chunks = parsePngChunks(buffer);
  const out = [];
  for (const chunk of chunks) {
    try {
      if (chunk.type === 'tEXt') {
        const kv = decodeText(chunk.data);
        if (kv) out.push(kv);
      } else if (chunk.type === 'iTXt') {
        const kv = await decodeItxt(chunk.data);
        if (kv) out.push(kv);
      } else if (chunk.type === 'zTXt') {
        const kv = await decodeZtxt(chunk.data);
        if (kv) out.push(kv);
      }
    } catch {
      // corrupt chunk — skip, keep parsing others
    }
  }
  return out;
}

/**
 * Detect AI-generator signatures in PNG text key/value pairs.
 * @param {Array<{key:string, value:string|null}>} pairs
 * @returns {{ hit: boolean, signals: string[] }}
 */
export function detectPngAiSignatures(pairs) {
  const signals = [];
  for (const { key, value } of pairs) {
    const k = (key ?? '').toLowerCase();
    const v = (value ?? '').toLowerCase();
    if (!value) continue;

    if (k === 'parameters' && A1111_PARAMS_RE.test(value)) {
      signals.push('png:tEXt parameters (A1111/Fooocus geninfo)');
    }
    if ((k === 'prompt' || k === 'workflow') && value.includes('class_type')) {
      signals.push(`png:${key} chunk (ComfyUI ${k})`);
    }
    if (k === 'invokeai_metadata' || k === 'invokeai_graph' || k === 'sd-metadata') {
      signals.push(`png:${key} (InvokeAI)`);
    }
    if (k === 'software' && v === 'novelai') {
      signals.push('png:Software=NovelAI');
    }
    if (k === 'comment' && v.startsWith('{') && v.includes('"uc"')) {
      signals.push('png:Comment JSON with "uc" (NovelAI)');
    }
    if (AI_SOFTWARE.some((s) => v.includes(s))) {
      signals.push(`png:${key} references "${AI_SOFTWARE.find((s) => v.includes(s))}"`);
    }
  }
  return { hit: signals.length > 0, signals };
}
