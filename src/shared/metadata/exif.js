/**
 * EXIF analysis via exifr (MIT). Detects AI-generator software tags and camera-field absence.
 * exifr is a runtime dependency bundled by esbuild; works in offscreen documents and workers.
 */
import * as exifr from 'exifr';

/** EXIF/XMP software-ish fields that frequently name the generator. */
const AI_SOFTWARE_TAGS = [
  'midjourney',
  'novelai',
  'adobe firefly',
  'dall-e',
  'dalle',
  'stable diffusion',
  'stablediffusion',
  'dreamstudio',
  'playground',
  'leonardo',
  'ideogram',
  'bing image creator',
  'microsoft designer',
  'imagefx',
  'comfyui',
  'invokeai',
  'fooocus',
];

/** A1111 geninfo fingerprint inside EXIF UserComment. */
const A1111_RE = /(Steps|Sampler|CFG scale|Seed|Model hash)\s*:/i;

const CAMERA_FIELDS = [
  'Make',
  'Model',
  'ExposureTime',
  'FNumber',
  'ISO',
  'ISOSpeedRatings',
  'Flash',
  'FocalLength',
];

/**
 * Analyze EXIF/XMP/IPTC metadata for camera fields + AI-generator software tags.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} format container format from detectFormat() ('jpeg'|'webp'|'avif-or-bmff'|'png')
 * @returns {Promise<{ hasCameraFields: boolean|null, aiSignals: string[], software: string|null }>}
 *   hasCameraFields: true/false when determinable, null when the format carries no EXIF
 */
export async function analyzeExif(buffer, format) {
  if (!['jpeg', 'webp', 'avif-or-bmff', 'png'].includes(format)) {
    return { hasCameraFields: null, aiSignals: [], software: null };
  }
  const input = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  let parsed = null;
  try {
    parsed = await exifr.parse(input, {
      tiff: true,
      ifd0: true,
      exif: true,
      xmp: true,
      iptc: true,
      pick: [
        'Software',
        'ImageDescription',
        'UserComment',
        'Artist',
        'Creator',
        'CreatorTool',
        'Make',
        'Model',
        'ExposureTime',
        'FNumber',
        'ISO',
        'ISOSpeedRatings',
        'Flash',
        'FocalLength',
      ],
    });
  } catch {
    return { hasCameraFields: null, aiSignals: [], software: null };
  }
  if (!parsed) return { hasCameraFields: false, aiSignals: [], software: null };

  const aiSignals = [];
  const hasCameraFields = CAMERA_FIELDS.some((f) => parsed[f] !== undefined && parsed[f] !== null);

  // Bare generator-name matching is restricted to fields that actually identify the producing
  // software (Software / CreatorTool). Artist and ImageDescription are free-text — a real photo
  // credited to an artist named "Leonardo" must not become a definitive AI hit.
  const softwareFields = [parsed.Software, parsed.CreatorTool]
    .filter((v) => typeof v === 'string')
    .map((v) => v.toLowerCase());
  const software = typeof parsed.Software === 'string' ? parsed.Software : null;

  for (const text of softwareFields) {
    const hit = AI_SOFTWARE_TAGS.find((s) => text.includes(s));
    if (hit) {
      aiSignals.push(`exif: software tag references "${hit}"`);
      break;
    }
  }

  // A1111 writes geninfo into EXIF UserComment for JPEG/WebP outputs.
  const uc = parsed.UserComment;
  if (uc != null) {
    let text = null;
    if (typeof uc === 'string') text = uc;
    else if (uc instanceof Uint8Array || Array.isArray(uc)) {
      text = new TextDecoder('utf-8', { fatal: false }).decode(
        uc instanceof Uint8Array ? uc : Uint8Array.from(uc),
      );
    }
    if (text && A1111_RE.test(text)) {
      aiSignals.push('exif: UserComment contains A1111 generation parameters');
    }
  }

  return { hasCameraFields, aiSignals, software };
}
