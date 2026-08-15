import { describe, expect, it } from 'vitest';
import { extractForensicSignals } from '../../src/shared/metadata/forensic-extractor.js';

function pngWithText(key, value) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const enc = new TextEncoder();
  const kv = new Uint8Array([...enc.encode(key), 0, ...enc.encode(value)]);
  const chunk = [];
  const len = kv.length;
  chunk.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  chunk.push(...enc.encode('tEXt'));
  chunk.push(...kv);
  chunk.push(0, 0, 0, 0);
  const iend = [0, 0, 0, 0, ...enc.encode('IEND'), 0, 0, 0, 0];
  return new Uint8Array([...sig, ...chunk, ...iend]).buffer;
}

describe('forensic-extractor', () => {
  it('returns a structured result for a PNG with A1111 geninfo', async () => {
    const png = pngWithText(
      'parameters',
      'a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42',
    );
    const out = await extractForensicSignals(png);
    expect(out.format).toBe('png');
    expect(out.definitive).toBe(true);
    expect(out.score).toBe(0.99);
    expect(out.summary.join(' ')).toMatch(/A1111|parameters/i);
  });

  it('returns non-definitive for a clean PNG', async () => {
    const png = pngWithText('Comment', 'holiday photo');
    const out = await extractForensicSignals(png);
    expect(out.definitive).toBe(false);
    expect(out.score).toBeNull();
  });

  it('never throws on garbage bytes', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 255, 254]).buffer;
    const out = await extractForensicSignals(garbage);
    expect(out.format).toBe('unknown');
    expect(out.definitive).toBe(false);
  });

  it('never throws on truncated PNG', async () => {
    const png = pngWithText('parameters', 'Steps: 1');
    const truncated = png.slice(0, 20);
    const out = await extractForensicSignals(truncated);
    expect(out).toBeTruthy();
  });

  it('accepts Uint8Array input', async () => {
    const png = new Uint8Array(pngWithText('Software', 'NovelAI'));
    const out = await extractForensicSignals(png);
    expect(out.definitive).toBe(true);
  });

  it('detects XMP DigitalSourceType in a JPEG as definitive', async () => {
    const enc = new TextEncoder();
    const xmp =
      '<x:xmpmeta><rdf:li>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</rdf:li></x:xmpmeta>';
    const payload = new Uint8Array([
      ...enc.encode('http://ns.adobe.com/xap/1.0/'),
      0,
      ...enc.encode(xmp),
    ]);
    const segLen = payload.length + 2;
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe1,
      (segLen >>> 8) & 0xff,
      segLen & 0xff,
      ...payload,
      0xff,
      0xd9,
    ]).buffer;
    const out = await extractForensicSignals(jpeg);
    expect(out.format).toBe('jpeg');
    expect(out.definitive).toBe(true);
    expect(out.summary.join(' ')).toMatch(/trainedAlgorithmicMedia/i);
  });

  it('reports indeterminate camera EXIF (null) for a bare JPEG with no EXIF segment', async () => {
    const clean = await extractForensicSignals(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
    // No EXIF segment parseable => hasCameraExif is null (unknown), which the fusion layer
    // treats as neutral (no nudge). This is the correct, non-misleading signal.
    expect(clean.features.hasCameraExif).toBeNull();
  });

  it('survives a PNG whose text chunk parse throws (zlib bomb guard path)', async () => {
    // iTXt with compression flag set but garbage compressed data -> inflate throws -> caught.
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const enc = new TextEncoder();
    const itxt = [...enc.encode('prompt'), 0, 1, 0, 0, 0, 0xff, 0xff, 0xff]; // flag=1, garbage
    const len = itxt.length;
    const chunk = [
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...enc.encode('iTXt'),
      ...itxt,
      0,
      0,
      0,
      0,
    ];
    const iend = [0, 0, 0, 0, ...enc.encode('IEND'), 0, 0, 0, 0];
    const png = new Uint8Array([...sig, ...chunk, ...iend]).buffer;
    const out = await extractForensicSignals(png);
    expect(out.format).toBe('png');
    expect(out.definitive).toBe(false);
  });

  it('handles a WebP with no metadata chunks (non-definitive)', async () => {
    // RIFF + WEBP + a single VP8 chunk (no EXIF/XMP/C2PA)
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x0e, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x02,
      0, 0, 0, 0x01, 0x02,
    ]).buffer;
    const out = await extractForensicSignals(webp);
    expect(out.format).toBe('webp');
    expect(out.definitive).toBe(false);
    expect(out.score).toBeNull();
  });

  it('returns unknown format and no definitive for an unsupported container', async () => {
    // A truncated GIF header (only 6 bytes) is below the 12-byte minimum for GIF detection,
    // so it is correctly classified 'unknown'. Either way it must be non-definitive.
    const gif = new TextEncoder().encode('GIF89a').buffer;
    const out = await extractForensicSignals(gif);
    expect(['gif', 'unknown']).toContain(out.format);
    expect(out.definitive).toBe(false);
    expect(out.score).toBeNull();
  });

  it('detects a C2PA-bearing PNG as definitive', async () => {
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
    const out = await extractForensicSignals(png);
    expect(out.definitive).toBe(true);
    expect(out.summary.join(' ')).toMatch(/c2pa/i);
  });
});
