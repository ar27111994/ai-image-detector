/**
 * C2PA / Content Credentials detection (byte-level; no heavy WASM dependency).
 *
 * We scan for the JUMBF manifest-store container in each format and, when present, extract
 * printable strings to identify the claim_generator (Adobe Firefly, DALL-E 3, Microsoft
 * Designer, ...). A valid C2PA manifest that references generative AI is near-certain
 * provenance. We do NOT cryptographically validate signatures in v1 — presence + claim text
 * is the signal.
 */
import {
  extractStrings,
  parseJpegSegments,
  parsePngChunks,
  parseWebpChunks,
} from './containers.js';

/** C2PA manifest-store JUMBF description UUID bytes ("c2ma"-uuid). */
const C2PA_UUID = [
  0x63, 0x32, 0x6d, 0x61, 0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

/** Generative-AI claim markers inside a C2PA manifest's JSON. */
const AI_CLAIM_MARKERS = [
  'c2pa.ai.generative',
  'trainedAlgorithmicMedia',
  'compositeWithTrainedAlgorithmicMedia',
  'dall-e',
  'dalle',
  'adobe firefly',
  'microsoft designer',
  'bing image creator',
  'imagefx',
  'imagen',
  'midjourney',
  'stable diffusion',
];

function containsBytes(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * JPEG: APP11 segments with "JP" discriminator carry JUMBF (C2PA).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Uint8Array[]} candidate C2PA manifest blobs
 */
function findJpegC2pa(buffer) {
  const blobs = [];
  for (const seg of parseJpegSegments(buffer)) {
    if (seg.marker !== 0xeb) continue; // APP11
    const d = seg.data;
    // "JP" common identifier at data[0..1] (0x4A 0x50)
    if (d.length > 8 && d[0] === 0x4a && d[1] === 0x50) blobs.push(d);
  }
  return blobs;
}

/**
 * PNG: caBX chunk carries the JUMBF manifest store.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Uint8Array[]} candidate C2PA manifest blobs
 */
function findPngC2pa(buffer) {
  return parsePngChunks(buffer)
    .filter((c) => c.type === 'caBX')
    .map((c) => c.data);
}

/**
 * WebP: RIFF chunk fourcc 'C2PA'.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Uint8Array[]} candidate C2PA manifest blobs
 */
function findWebpC2pa(buffer) {
  return parseWebpChunks(buffer)
    .filter((c) => c.fourcc === 'C2PA')
    .map((c) => c.data);
}

/**
 * Detect C2PA manifests and extract provenance signals.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} format 'jpeg' | 'png' | 'webp' (others yield no blobs)
 * @returns {{ present: boolean, hit: boolean, signals: string[], generators: string[] }}
 *   present = a C2PA manifest exists; hit = it names a known AI generator
 */
export function detectC2pa(buffer, format) {
  let blobs = [];
  if (format === 'jpeg') blobs = findJpegC2pa(buffer);
  else if (format === 'png') blobs = findPngC2pa(buffer);
  else if (format === 'webp') blobs = findWebpC2pa(buffer);

  if (!blobs.length) return { present: false, hit: false, signals: [], generators: [] };

  const signals = [];
  const generators = new Set();
  let sawManifest = false;

  // Only trust blobs that carry the JUMBF manifest-store UUID. A crafted APP11 "JP" / PNG caBX /
  // WebP C2PA chunk containing a known claim marker but no valid manifest UUID must NOT be
  // treated as provenance — otherwise an attacker could plant a marker in an arbitrary chunk to
  // force a definitive AI verdict on a real photo.
  for (const blob of blobs) {
    if (!containsBytes(blob, C2PA_UUID)) continue;
    sawManifest = true;
    const strings = extractStrings(blob, 6, 512).join('\n');
    const lower = strings.toLowerCase();
    for (const marker of AI_CLAIM_MARKERS) {
      if (lower.includes(marker.toLowerCase())) {
        signals.push(`c2pa:${marker}`);
        // Claim generator names that map to known AI products.
        if (
          [
            'dall-e',
            'dalle',
            'adobe firefly',
            'microsoft designer',
            'bing image creator',
            'imagefx',
            'imagen',
            'midjourney',
            'stable diffusion',
          ].includes(marker)
        ) {
          generators.add(marker);
        }
      }
    }
    const cg = lower.match(/claim_generator[^a-z0-9]+"?([a-z0-9 ._\-/]+)"?/);
    if (cg) generators.add(cg[1].trim());
  }

  if (sawManifest) signals.unshift('c2pa:manifest-store present');
  // present = a UUID-validated manifest-store exists (drives the fast path); hit = it also names
  // a known AI generator. A candidate blob with no valid UUID yields neither.
  const hit = signals.some((s) => s !== 'c2pa:manifest-store present');
  return { present: sawManifest, hit, signals, generators: [...generators] };
}
