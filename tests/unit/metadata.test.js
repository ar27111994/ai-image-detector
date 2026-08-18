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
  it('detects gif (GIF87a/89a)', () => {
    expect(detectFormat(new TextEncoder().encode('GIF89a' + '\0'.repeat(10)).buffer)).toBe('gif');
  });
  it('detects avif-or-bmff from an ftyp box', () => {
    const b = new Uint8Array(16);
    b.set([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70], 0); // ftyp at offset 4
    expect(detectFormat(b.buffer)).toBe('avif-or-bmff');
  });
  it('returns unknown for a RIFF container that is not WEBP', () => {
    const b = new Uint8Array(16);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF but no WEBP fourcc
    b.set([0x57, 0x41, 0x56, 0x45], 8); // 'WAVE' instead
    expect(detectFormat(b.buffer)).toBe('unknown');
  });
  it('returns unknown when input is shorter than the 12-byte minimum', () => {
    expect(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBe('unknown');
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
      '<x:xmpmeta><Iptc4xmpCore:DigitalSourceType><rdf:Seq><rdf:li>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</rdf:li></rdf:Seq></Iptc4xmpCore:DigitalSourceType></x:xmpmeta>',
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
  it('flags a known AI creator tool in the rdf:li element form', () => {
    // The detector lowercases the packet; the rdf:li branch matches <xmp:creatortool> form.
    const { hit, signals } = detectXmpAiSignatures([
      '<xmp:creatortool><rdf:li>Stable Diffusion</rdf:li></xmp:creatortool>',
    ]);
    expect(hit).toBe(true);
    expect(signals.join(' ')).toMatch(/CreatorTool/i);
  });
  it('does not flag an rdf:li creator tool that is not an AI generator', () => {
    const { hit } = detectXmpAiSignatures([
      '<xmp:creatortool><rdf:li>Canon EOS Utility</rdf:li></xmp:creatortool>',
    ]);
    expect(hit).toBe(false);
  });

  it('does NOT treat trainedAlgorithmicMedia in a random description as a DigitalSourceType claim', () => {
    // Adversarial: the term appears in an unrelated dc:description, not as the IPTC
    // DigitalSourceType property — must not force a definitive AI verdict.
    const { hit } = detectXmpAiSignatures([
      '<x:xmpmeta><dc:description><rdf:li>A note about trainedAlgorithmicMedia detectors</rdf:li></dc:description></x:xmpmeta>',
    ]);
    expect(hit).toBe(false);
  });

  it('flags trainedAlgorithmicMedia as a DigitalSourceType attribute', () => {
    const { hit, digitalSourceType } = detectXmpAiSignatures([
      '<x:xmpmeta><rdf:Description Iptc4xmpCore:DigitalSourceType="trainedAlgorithmicMedia"/></x:xmpmeta>',
    ]);
    expect(hit).toBe(true);
    expect(digitalSourceType).toBe('trainedAlgorithmicMedia');
  });

  it('flags trainedAlgorithmicMedia inside a DigitalSourceType rdf:li container', () => {
    const { hit } = detectXmpAiSignatures([
      '<x:xmpmeta><Iptc4xmpCore:DigitalSourceType><rdf:Seq><rdf:li>trainedAlgorithmicMedia</rdf:li></rdf:Seq></Iptc4xmpCore:DigitalSourceType></x:xmpmeta>',
    ]);
    expect(hit).toBe(true);
  });

  it('does NOT match a foreign property that merely ENDS in DigitalSourceType (attribute form)', () => {
    const { hit } = detectXmpAiSignatures([
      '<x:xmpmeta><rdf:Description ex:NotDigitalSourceType="trainedAlgorithmicMedia"/></x:xmpmeta>',
    ]);
    expect(hit).toBe(false);
  });

  it('does NOT match a foreign element named *NotDigitalSourceType* (container form)', () => {
    const { hit } = detectXmpAiSignatures([
      '<x:xmpmeta><ex:NotDigitalSourceType><rdf:Seq><rdf:li>trainedAlgorithmicMedia</rdf:li></rdf:Seq></ex:NotDigitalSourceType></x:xmpmeta>',
    ]);
    expect(hit).toBe(false);
  });

  it('still matches the exact unqualified DigitalSourceType name', () => {
    const { hit } = detectXmpAiSignatures([
      '<x:xmpmeta><rdf:Description DigitalSourceType="trainedAlgorithmicMedia"/></x:xmpmeta>',
    ]);
    expect(hit).toBe(true);
  });

  it('does NOT treat the controlled-vocabulary URI in a random description as a DigitalSourceType claim', () => {
    // Adversarial: the full IPTC URI appears only in dc:description text, with no DigitalSourceType
    // property — must not force a definitive AI verdict even though it names the CV term.
    const { hit } = detectXmpAiSignatures([
      '<x:xmpmeta><dc:description><rdf:li>See http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia for the spec</rdf:li></dc:description></x:xmpmeta>',
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

  it('detects a C2PA manifest in a JPEG APP11 segment with a generative claim', () => {
    const enc = new TextEncoder();
    const uuid = [
      0x63, 0x32, 0x6d, 0x61, 0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b,
      0x71,
    ];
    const claim = enc.encode('{"claim_generator":"DALL-E 3","actions":["c2pa.ai.generative"]}');
    const jumbf = new Uint8Array([0x4a, 0x50, 0, 1, 0, 0, 0, 1, ...uuid, ...claim]); // "JP" + box + uuid + claim
    const segLen = jumbf.length + 2;
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xeb,
      (segLen >>> 8) & 0xff,
      segLen & 0xff,
      ...jumbf,
      0xff,
      0xd9,
    ]).buffer;
    const res = detectC2pa(jpeg, 'jpeg');
    expect(res.present).toBe(true);
    expect(res.hit).toBe(true);
    expect(res.signals.join(' ')).toMatch(/c2pa\.ai\.generative|DALL-E/i);
  });

  it('detects a C2PA manifest in a WebP C2PA chunk', () => {
    const enc = new TextEncoder();
    const uuid = [
      0x63, 0x32, 0x6d, 0x61, 0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b,
      0x71,
    ];
    const claim = enc.encode('{"claim_generator":"Microsoft Designer"}');
    const jumbf = new Uint8Array([...uuid, ...claim]);
    const chunk = [...enc.encode('C2PA'), jumbf.length & 0xff, 0, 0, 0, ...jumbf];
    if (jumbf.length % 2) chunk.push(0);
    const webp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      (chunk.length + 4) & 0xff,
      0,
      0,
      0,
      0x57,
      0x45,
      0x42,
      0x50,
      ...chunk,
    ]).buffer;
    const res = detectC2pa(webp, 'webp');
    expect(res.present).toBe(true);
    expect(res.generators.join(' ')).toMatch(/Microsoft Designer/i);
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

  it('ignores a crafted caBX chunk with an AI marker but NO valid manifest UUID', () => {
    // Adversarial: a PNG caBX chunk that contains a known claim marker but lacks the JUMBF
    // manifest-store UUID must NOT be treated as provenance (otherwise it forces a false
    // definitive AI verdict on a real photo).
    const enc = new TextEncoder();
    const claim = enc.encode('{"claim_generator":"DALL-E 3","actions":["c2pa.ai.generative"]}');
    const jumbf = new Uint8Array([...claim]); // NO C2PA_UUID prefix
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
    expect(res.present).toBe(false); // no UUID-validated manifest
    expect(res.hit).toBe(false); // must not become a definitive verdict
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

  it('passes through neural score when calibration is disabled and no forensic', () => {
    const out = fuseSignals(
      {
        neuralScore: 0.8,
        forensic: {
          definitive: false,
          summary: [],
          features: { format: 'jpeg', hasCameraExif: null },
        },
      },
      { calibration: { enabled: false, a: 1, b: 0 } },
    );
    expect(out.score).toBeCloseTo(0.8, 5);
  });

  it('camera EXIF slightly lowers the score', () => {
    const off = { calibration: { enabled: false, a: 1, b: 0 } };
    const withCam = fuseSignals(
      {
        neuralScore: 0.5,
        forensic: {
          definitive: false,
          summary: [],
          features: { format: 'jpeg', hasCameraExif: true },
        },
      },
      off,
    );
    const without = fuseSignals(
      {
        neuralScore: 0.5,
        forensic: {
          definitive: false,
          summary: [],
          features: { format: 'jpeg', hasCameraExif: false },
        },
      },
      off,
    );
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
  it('parseWebpChunks returns [] for a RIFF container that is not WEBP', () => {
    const notWebp = new Uint8Array(16);
    notWebp.set([0x52, 0x49, 0x46, 0x46], 0);
    notWebp.set([0x57, 0x41, 0x56, 0x45], 8); // 'WAVE' fourcc, not 'WEBP'
    expect(parseWebpChunks(notWebp.buffer)).toEqual([]);
  });
  it('parseJpegSegments tolerates non-0xff padding bytes between segments', () => {
    // SOI, a padding byte, then APP1 with a tiny payload, then EOI.
    const bytes = [
      0xff,
      0xd8, // SOI
      0x00, // padding (not 0xff) — exercises the tolerate-padding branch
      0xff,
      0xe1,
      0x00,
      0x04,
      0xaa,
      0xbb, // APP1 len=4 -> 2 payload bytes
      0xff,
      0xd9, // EOI
    ];
    const segs = parseJpegSegments(new Uint8Array(bytes).buffer);
    expect(segs.length).toBeGreaterThan(0);
    expect(segs[0].marker).toBe(0xe1);
  });
  it('parseJpegSegments stops at EOI and skips standalone markers', () => {
    // SOI -> RST0 (standalone, no length) -> EOI. No APPn segments.
    const bytes = [0xff, 0xd8, 0xff, 0xd0, 0xff, 0xd9];
    const segs = parseJpegSegments(new Uint8Array(bytes).buffer);
    expect(segs).toEqual([]);
  });
  it('parseJpegSegments stops on a segment whose declared length overruns the buffer', () => {
    // SOI -> APP1 with a huge declared length -> parser must bail (not read OOB).
    const bytes = [0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01]; // length 0xffff, buffer ends
    const segs = parseJpegSegments(new Uint8Array(bytes).buffer);
    expect(segs).toEqual([]);
  });
  it('extractStrings pulls printable runs', () => {
    const bytes = new Uint8Array([0, 0, 0x46, 0x69, 0x72, 0x65, 0x66, 0x6c, 0x79, 0, 0]).buffer;
    expect(extractStrings(bytes, 4)).toContain('Firefly');
  });
  it('extractStrings truncates runs to maxLength', () => {
    const longRun = new Uint8Array(300).fill(0x41); // 300 'A's
    const out = extractStrings(longRun.buffer, 4, 64);
    expect(out[0].length).toBeLessThanOrEqual(64);
  });
});

describe('fusion.fuseSignals — defensive null/guard branches', () => {
  it('handles a null forensic object (defaults to no summary, no definitive)', () => {
    const out = fuseSignals(
      { neuralScore: 0.8, forensic: null },
      { calibration: { enabled: false, a: 1, b: 0 } },
    );
    expect(out.score).toBeCloseTo(0.8, 5);
    expect(out.reasons).toEqual([]);
  });

  it('handles an undefined forensic summary (?? [] branch)', () => {
    const out = fuseSignals(
      { neuralScore: 0.8, forensic: { definitive: false, features: {} } },
      { calibration: { enabled: false, a: 1, b: 0 } },
    );
    expect(out.reasons).toEqual([]);
    expect(out.verdict).toBeDefined();
  });

  it('uses the default threshold when opts.threshold is omitted', () => {
    const out = fuseSignals(
      { neuralScore: 0.8, forensic: { definitive: false, summary: [], features: {} } },
      { calibration: { enabled: false, a: 1, b: 0 } },
    );
    expect(out.verdict).toBe('ai'); // 0.8 >= 0.65 default
  });
});

describe('metrics.perGroupMetrics — guard branches', () => {
  it('groups rows under "unknown" when keyFn returns null/undefined', async () => {
    const { perGroupMetrics } = await import('../../src/shared/metrics.js');
    const rows = [{ label: 'fake', score: 0.9 }];
    const out = perGroupMetrics(rows, () => null, 0.65);
    expect(out[0].group).toBe('unknown');
  });
});
