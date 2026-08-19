/**
 * Forensic signal orchestrator: runs all metadata/container detectors over image bytes and
 * returns a normalized result. Pure analysis — no network, no DOM. Runs in the offscreen doc.
 *
 * Returns:
 * {
 *   format,                       // 'png' | 'jpeg' | 'webp' | 'gif' | 'avif-or-bmff' | 'unknown'
 *   definitive: boolean,          // a near-certain AI provenance signal fired
 *   score: number|null,           // 0.99 if definitive, else null (defer to fusion)
 *   summary: string[],            // human-readable reasons
 *   features: { ... },            // weak signals for the fusion layer
 * }
 */
import { detectFormat } from './containers.js';
import { detectPngAiSignatures, extractPngText } from './png-text.js';
import { detectXmpAiSignatures, extractXmpPackets } from './xmp.js';
import { detectC2pa } from './c2pa.js';
import { analyzeExif } from './exif.js';

/**
 * Run all forensic/metadata detectors over image bytes.
 * @param {ArrayBuffer|Uint8Array} bytes encoded image (jpeg/png/webp/gif/avif)
 * @returns {Promise<{
 *   format: string,
 *   definitive: boolean,
 *   score: number|null,
 *   summary: string[],
 *   features: { format: string, hasCameraExif: boolean|null, pngAiHit: boolean, xmpAiHit: boolean, c2paPresent: boolean, c2paHit: boolean, exifAiHit: boolean }
 * }>}
 */
export async function extractForensicSignals(bytes) {
  const buffer =
    bytes instanceof Uint8Array
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : bytes;
  const format = detectFormat(buffer);

  const summary = [];
  const features = {
    format,
    hasCameraExif: null,
    pngAiHit: false,
    xmpAiHit: false,
    c2paPresent: false,
    c2paHit: false,
    exifAiHit: false,
  };

  let definitive = false;

  try {
    // EXIF (JPEG/WebP/AVIF): camera fields + AI software tags.
    const exif = await analyzeExif(buffer, format);
    features.hasCameraExif = exif.hasCameraFields;
    if (exif.aiSignals.length) {
      features.exifAiHit = true;
      summary.push(...exif.aiSignals);
      definitive = true;
    }
  } catch {
    /* exif parse failure is non-fatal */
  }

  try {
    if (format === 'png') {
      const pairs = await extractPngText(buffer);
      const png = detectPngAiSignatures(pairs);
      if (png.hit) {
        features.pngAiHit = true;
        summary.push(...png.signals);
        definitive = true;
      }
    }
  } catch {
    /* non-fatal */
  }

  try {
    if (format === 'jpeg' || format === 'webp') {
      const packets = extractXmpPackets(buffer, format);
      const xmp = detectXmpAiSignatures(packets);
      if (xmp.hit) {
        features.xmpAiHit = true;
        summary.push(...xmp.signals);
        definitive = true;
      }
    }
  } catch {
    /* non-fatal */
  }

  try {
    const c2pa = detectC2pa(buffer, format);
    features.c2paPresent = c2pa.present;
    if (c2pa.present) summary.push('C2PA manifest present');
    if (c2pa.hit) {
      features.c2paHit = true;
      summary.push(...c2pa.signals);
      definitive = true;
    }
  } catch {
    /* non-fatal */
  }

  return {
    format,
    definitive,
    score: definitive ? 0.99 : null,
    summary,
    features,
  };
}
