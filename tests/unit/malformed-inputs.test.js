/**
 * Malformed / adversarial input handling: parsers and preprocessors must never throw or read
 * out of bounds on corrupt data. These are the fuzz surface for untrusted web images.
 */
import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  extractStrings,
  parseJpegSegments,
  parsePngChunks,
  parseWebpChunks,
} from '../../src/shared/metadata/containers.js';
import { extractPngText, detectPngAiSignatures } from '../../src/shared/metadata/png-text.js';
import { detectC2pa } from '../../src/shared/metadata/c2pa.js';
import { extractForensicSignals } from '../../src/shared/metadata/forensic-extractor.js';
import {
  preprocessRgba,
  resizeRgbaBilinear,
  rgbaToChwTensor,
} from '../../src/shared/preprocess.js';

function randBytes(n, seed = 1) {
  const b = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    b[i] = s & 0xff;
  }
  return b.buffer;
}

describe('malformed container inputs', () => {
  it('detectFormat on empty/tiny/garbage never throws', () => {
    expect(detectFormat(new ArrayBuffer(0))).toBe('unknown');
    expect(detectFormat(new Uint8Array([0xff]).buffer)).toBe('unknown');
    expect(detectFormat(randBytes(64))).toBe('unknown');
  });

  it('parsePngChunks rejects corrupt length fields without OOB', () => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    // chunk declares a huge length but data is short
    const corrupt = new Uint8Array([...sig, 0xff, 0xff, 0xff, 0xff, 0x74, 0x45, 0x58, 0x74]).buffer;
    expect(() => parsePngChunks(corrupt)).not.toThrow();
    expect(parsePngChunks(corrupt)).toEqual([]);
  });

  it('parseJpegSegments handles truncated segments and garbage padding', () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]).buffer;
    expect(() => parseJpegSegments(jpg)).not.toThrow();
  });

  it('parseWebpChunks rejects oversized chunk declarations', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0xff, 0xff, 0xff, 0xff, 0x57, 0x45, 0x42, 0x50, 0x58, 0x4d, 0x50,
      0x20, 0xff, 0xff, 0xff, 0xff,
    ]).buffer;
    expect(() => parseWebpChunks(webp)).not.toThrow();
  });

  it('extractStrings on binary noise returns only printable runs', () => {
    const out = extractStrings(randBytes(512, 7), 4);
    for (const s of out) expect(/^[ -~]+$/.test(s)).toBe(true);
  });
});

describe('malformed PNG/C2PA/forensic inputs', () => {
  it('extractPngText on a corrupt PNG does not throw', async () => {
    const bad = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]).buffer;
    await expect(extractPngText(bad)).resolves.toEqual([]);
  });

  it('detectPngAiSignatures on null/empty values never throws', () => {
    expect(detectPngAiSignatures([{ key: 'parameters', value: null }])).toEqual({
      hit: false,
      signals: [],
    });
    expect(detectPngAiSignatures([])).toEqual({ hit: false, signals: [] });
  });

  it('detectC2pa on random bytes returns absent', () => {
    expect(detectC2pa(randBytes(4096, 13), 'png').present).toBe(false);
  });

  it('extractForensicSignals on a 1MB random buffer completes without throwing', async () => {
    const out = await extractForensicSignals(randBytes(1024 * 1024, 99));
    expect(out.definitive).toBe(false);
  }, 15000);
});

describe('preprocess adversarial inputs', () => {
  it('resizeRgbaBilinear rejects mismatched source length', () => {
    expect(() => resizeRgbaBilinear(new Uint8ClampedArray(10), 4, 4, 2, 2)).toThrow(RangeError);
  });

  it('rgbaToChwTensor rejects zero-area tensors', () => {
    expect(() => rgbaToChwTensor(new Uint8ClampedArray(0), 0, 0)).toThrow(RangeError);
  });

  it('preprocessRgba handles extreme aspect ratios', () => {
    const rgba = new Uint8ClampedArray(4000 * 4 * 4).fill(128); // 4000x4
    const { dims } = preprocessRgba(rgba, 4000, 4, {
      inputSize: 224,
      mean: [0.5, 0.5, 0.5],
      std: [0.5, 0.5, 0.5],
    });
    expect(dims).toEqual([1, 3, 224, 224]);
  });
});
