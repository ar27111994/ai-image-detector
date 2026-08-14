import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  extractStrings,
  parseJpegSegments,
  parsePngChunks,
  parseWebpChunks,
} from '../../src/shared/metadata/containers.js';
import { detectPngAiSignatures } from '../../src/shared/metadata/png-text.js';
import { detectXmpAiSignatures } from '../../src/shared/metadata/xmp.js';
import { detectC2pa } from '../../src/shared/metadata/c2pa.js';
import { fuseSignals, verdictFor, calibrate } from '../../src/shared/fusion/fuse.js';

/* ------------------------- synthetic fixture builders ------------------------- */

function pngWithTextChunk(key, value) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const enc = new TextEncoder();
  const kv = new Uint8Array([...enc.encode(key), 0, ...enc.encode(value)]);
  const chunk = [];
  const len = kv.length;
  chunk.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  chunk.push(...enc.encode('tEXt'));
  chunk.push(...kv);
  chunk.push(0, 0, 0, 0); // crc (not validated by our parser)
  const iend = [0, 0, 0, 0, ...enc.encode('IEND'), 0, 0, 0, 0];
  return new Uint8Array([...sig, ...chunk, ...iend]).buffer;
}

function jpegWithApp1Xmp(xmp) {
  const enc = new TextEncoder();
  const payload = new Uint8Array([
    ...enc.encode('http://ns.adobe.com/xap/1.0/\0'),
    ...enc.encode(xmp),
  ]);
  const segLen = payload.length + 2;
  const bytes = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe1, // APP1
    (segLen >>> 8) & 0xff,
    segLen & 0xff,
    ...payload,
    0xff,
    0xd9, // EOI
  ];
  return new Uint8Array(bytes).buffer;
}

describe('containers.detectFormat', () => {
  it('detects png', () => {
    expect(detectFormat(pngWithTextChunk('k', 'v'))).toBe('png');
  });
  it('detects jpeg', () => {
    expect(detectFormat(jpegWithApp1Xmp('<x/>'))).toBe('jpeg');
  });
  it('detects webp', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
    ]).buffer;
    expect(detectFormat(webp)).toBe('webp');
  });
  it('returns unknown for garbage', () => {
    expect(detectFormat(new Uint8Array([1, 2, 3]).buffer)).toBe('unknown');
  });
});

describe('containers.parsePngChunks', () => {
  it('parses tEXt chunks', () => {
    const chunks = parsePngChunks(pngWithTextChunk('parameters', 'Steps: 20, Sampler: Euler'));
    expect(chunks.map((c) => c.type)).toContain('tEXt');
  });
  it('stops cleanly on truncated input', () => {
    const full = new Uint8Array(pngWithTextChunk('a', 'b'));
    const truncated = full.slice(0, 14).buffer;
    expect(() => parsePngChunks(truncated)).not.toThrow();
  });
});

describe('png-text.detectPngAiSignatures', () => {
  it('flags A1111 parameters', () => {
    const { hit, signals } = detectPngAiSignatures([
      { key: 'parameters', value: 'a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1' },
    ]);
    expect(hit).toBe(true);
    expect(signals[0]).toMatch(/A1111|parameters/i);
  });
  it('flags ComfyUI prompt chunk', () => {
    const { hit } = detectPngAiSignatures([
      { key: 'prompt', value: '{"1":{"class_type":"KSampler"}}' },
    ]);
    expect(hit).toBe(true);
  });
  it('flags NovelAI software tag', () => {
    const { hit } = detectPngAiSignatures([{ key: 'Software', value: 'NovelAI' }]);
    expect(hit).toBe(true);
  });
  it('does not flag innocuous text', () => {
    const { hit } = detectPngAiSignatures([{ key: 'Comment', value: 'holiday photo 2024' }]);
    expect(hit).toBe(false);
  });
});

describe('xmp.detectXmpAiSignatures', () => {
  it('flags trainedAlgorithmicMedia DigitalSourceType', () => {
    const packets = [
      '<x:xmpmeta><rdf:li>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</rdf:li></x:xmpmeta>',
    ];
    const { hit, digitalSourceType } = detectXmpAiSignatures(packets);
    expect(hit).toBe(true);
    expect(digitalSourceType).toBe('trainedAlgorithmicMedia');
  });
  it('flags known AI creator tools', () => {
    const { hit } = detectXmpAiSignatures(['<rdf:li xmp:CreatorTool="Midjourney"/>']);
    expect(hit).toBe(true);
  });
  it('ignores plain camera XMP', () => {
    const { hit } = detectXmpAiSignatures([
      '<x:xmpmeta><xmp:CreatorTool>Adobe Lightroom</xmp:CreatorTool></x:xmpmeta>',
    ]);
    expect(hit).toBe(false);
  });
});

describe('c2pa.detectC2pa', () => {
  it('reports absent for a plain jpeg', () => {
    const res = detectC2pa(jpegWithApp1Xmp('<x/>'), 'jpeg');
    expect(res.present).toBe(false);
    expect(res.hit).toBe(false);
  });
  it('detects a C2PA manifest store in PNG caBX with generative claim', () => {
    const enc = new TextEncoder();
    const uuid = [
      0x63, 0x32, 0x6d, 0x61, 0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b,
      0x71,
    ];
    const claim = enc.encode(
      '{"claim_generator":"Adobe Firefly","actions":["c2pa.ai.generative"]}',
    );
    const jumbf = new Uint8Array([...uuid, 0, 0, 0, 0, ...claim]);
    const cabx = [];
    const len = jumbf.length;
    cabx.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    cabx.push(...enc.encode('caBX'));
    cabx.push(...jumbf);
    cabx.push(0, 0, 0, 0);
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const iend = [0, 0, 0, 0, ...enc.encode('IEND'), 0, 0, 0, 0];
    const png = new Uint8Array([...sig, ...cabx, ...iend]).buffer;
    const res = detectC2pa(png, 'png');
    expect(res.present).toBe(true);
    expect(res.hit).toBe(true);
    expect(res.signals.join(' ')).toMatch(/c2pa\.ai\.generative|Firefly/i);
  });
});

describe('fusion.fuseSignals', () => {
  it('returns 0.99 AI for definitive forensic hit regardless of neural score', () => {
    const out = fuseSignals({
      neuralScore: 0.05,
      forensic: { definitive: true, summary: ['c2pa'], features: {} },
    });
    expect(out.score).toBe(0.99);
    expect(out.verdict).toBe('ai');
  });

  it('passes through neural score when calibration disabled and no forensic', () => {
    const out = fuseSignals({
      neuralScore: 0.8,
      forensic: {
        definitive: false,
        summary: [],
        features: { format: 'jpeg', hasCameraExif: null },
      },
    });
    expect(out.score).toBeCloseTo(0.8, 5);
  });

  it('camera EXIF slightly lowers the score', () => {
    const withCam = fuseSignals({
      neuralScore: 0.5,
      forensic: {
        definitive: false,
        summary: [],
        features: { format: 'jpeg', hasCameraExif: true },
      },
    });
    const without = fuseSignals({
      neuralScore: 0.5,
      forensic: {
        definitive: false,
        summary: [],
        features: { format: 'jpeg', hasCameraExif: false },
      },
    });
    expect(withCam.score).toBeLessThan(without.score);
  });
});

describe('fusion.verdictFor', () => {
  it('maps scores to verdict bands at 0.65', () => {
    expect(verdictFor(0.9, 0.65)).toBe('ai');
    expect(verdictFor(0.65, 0.65)).toBe('ai');
    expect(verdictFor(0.5, 0.65)).toBe('uncertain');
    expect(verdictFor(0.2, 0.65)).toBe('real');
  });
});

describe('fusion.calibrate', () => {
  it('is identity when disabled', () => {
    expect(calibrate(0.42, { enabled: false, a: 2, b: 3 })).toBeCloseTo(0.42, 6);
  });
  it('applies logistic mapping when enabled', () => {
    const out = calibrate(0.9, { enabled: true, a: 1, b: 0 });
    expect(out).toBeCloseTo(0.9, 1); // logit(0.9) is stable under a=1,b=0
  });
  it('clamps to [0,1]', () => {
    expect(calibrate(0.999, { enabled: true, a: 10, b: 50 })).toBeLessThanOrEqual(1);
  });
});

describe('containers misc', () => {
  it('parseJpegSegments stops at SOS', () => {
    const segs = parseJpegSegments(jpegWithApp1Xmp('<x/>'));
    expect(segs.length).toBeGreaterThan(0);
    expect(segs[0].marker).toBe(0xe1);
  });
  it('parseWebpChunks handles empty', () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x0c, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
      .buffer;
    expect(parseWebpChunks(webp)).toEqual([]);
  });
  it('extractStrings pulls printable runs', () => {
    const bytes = new Uint8Array([0, 0, 0x46, 0x69, 0x72, 0x65, 0x66, 0x6c, 0x79, 0, 0]).buffer;
    expect(extractStrings(bytes, 4)).toContain('Firefly');
  });
});
