import { describe, expect, it } from 'vitest';
import { extractPngText } from '../../src/shared/metadata/png-text.js';
import { extractXmpPackets, detectXmpAiSignatures } from '../../src/shared/metadata/xmp.js';
import { parseJpegSegments } from '../../src/shared/metadata/containers.js';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const enc = new TextEncoder();

function pngChunk(type, dataBytes) {
  const len = dataBytes.length;
  const out = [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...enc.encode(type),
    ...dataBytes,
    0,
    0,
    0,
    0,
  ];
  return out;
}

function pngWith(chunks) {
  const iend = [0, 0, 0, 0, ...enc.encode('IEND'), 0, 0, 0, 0];
  return new Uint8Array([...PNG_SIG, ...chunks.flat(), ...iend]).buffer;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('png-text extractPngText decode paths', () => {
  it('decodes a tEXt chunk', async () => {
    const kv = new Uint8Array([...enc.encode('key'), 0, ...enc.encode('value')]);
    const pairs = await extractPngText(pngWith([pngChunk('tEXt', kv)]));
    expect(pairs).toContainEqual({ key: 'key', value: 'value' });
  });

  it('decodes an uncompressed iTXt chunk', async () => {
    // keyword\x00 flag(0) method(0) lang\x00 translated\x00 value
    const kv = new Uint8Array([
      ...enc.encode('prompt'),
      0,
      0,
      0,
      0,
      0,
      ...enc.encode('{"a":1,"class_type":"X"}'),
    ]);
    const pairs = await extractPngText(pngWith([pngChunk('iTXt', kv)]));
    expect(pairs[0].key).toBe('prompt');
    expect(pairs[0].value).toContain('class_type');
  });

  it('decodes a compressed zTXt chunk', async () => {
    const compressed = await deflate(enc.encode('Steps: 20, Sampler: Euler'));
    const kv = new Uint8Array([...enc.encode('parameters'), 0, 0, ...compressed]);
    const pairs = await extractPngText(pngWith([pngChunk('zTXt', kv)]));
    expect(pairs[0].key).toBe('parameters');
    expect(pairs[0].value).toContain('Steps: 20');
  });

  it('returns empty for a PNG with no text chunks', async () => {
    const idat = pngChunk('IDAT', new Uint8Array([1, 2, 3]));
    expect(await extractPngText(pngWith([idat]))).toEqual([]);
  });

  it('skips a corrupt tEXt chunk without throwing', async () => {
    const bad = pngChunk('tEXt', new Uint8Array([1, 2, 3])); // no null separator
    const good = pngChunk('tEXt', new Uint8Array([...enc.encode('a'), 0, ...enc.encode('b')]));
    const pairs = await extractPngText(pngWith([bad, good]));
    expect(pairs).toContainEqual({ key: 'a', value: 'b' });
  });

  it('returns null value for a zTXt chunk with an unknown compression method', async () => {
    // keyword\x00 method(1 — invalid, only 0=deflate is valid) -> value:null without inflating.
    const kv = new Uint8Array([...enc.encode('parameters'), 0, 1, 0, 0, 0]);
    const pairs = await extractPngText(pngWith([pngChunk('zTXt', kv)]));
    expect(pairs[0]).toEqual({ key: 'parameters', value: null });
  });

  it('returns null for a zTXt chunk with no null separator', async () => {
    const kv = new Uint8Array([1, 2, 3, 4]); // no \x00
    const pairs = await extractPngText(pngWith([pngChunk('zTXt', kv)]));
    expect(pairs).toEqual([]);
  });

  it('decodes a compressed iTXt chunk (compressionFlag=1, method=0)', async () => {
    const compressed = await deflate(enc.encode('{"1":{"class_type":"KSampler"}}'));
    const kv = new Uint8Array([
      ...enc.encode('prompt'),
      0,
      1, // compressionFlag = compressed
      0, // method = deflate
      0, // language tag (empty) + null
      0, // translated keyword (empty) + null
      ...compressed,
    ]);
    const pairs = await extractPngText(pngWith([pngChunk('iTXt', kv)]));
    expect(pairs[0].key).toBe('prompt');
    expect(pairs[0].value).toContain('class_type');
  });

  it('returns null value for a truncated iTXt chunk (keyword but no flag bytes)', async () => {
    // keyword\x00 then nothing (i+2 > length) -> { key, value:null }
    const kv = new Uint8Array([...enc.encode('prompt'), 0]);
    const pairs = await extractPngText(pngWith([pngChunk('iTXt', kv)]));
    expect(pairs[0]).toEqual({ key: 'prompt', value: null });
  });
});

describe('xmp extractXmpPackets', () => {
  it('extracts XMP from a JPEG APP1 segment', () => {
    const xmp =
      '<x:xmpmeta xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"><rdf:Description Iptc4xmpCore:DigitalSourceType="trainedAlgorithmicMedia"/></x:xmpmeta>';
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
    const packets = extractXmpPackets(jpeg, 'jpeg');
    expect(packets.length).toBe(1);
    expect(packets[0]).toContain('trainedAlgorithmicMedia');
    expect(detectXmpAiSignatures(packets).hit).toBe(true);
  });

  it('extracts XMP from a WebP XMP chunk', () => {
    const xmp = enc.encode(
      '<x xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Midjourney"></x>',
    );
    const chunk = [...enc.encode('XMP '), xmp.length & 0xff, 0, 0, 0, ...xmp];
    if (xmp.length % 2) chunk.push(0); // padding
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
    const packets = extractXmpPackets(webp, 'webp');
    expect(packets.length).toBe(1);
    expect(detectXmpAiSignatures(packets).hit).toBe(true);
  });

  it('returns empty for non-XMP jpeg', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    expect(extractXmpPackets(jpeg, 'jpeg')).toEqual([]);
  });
});

describe('containers.parseJpegSegments edge cases', () => {
  it('handles a bare SOI+EOI jpeg', () => {
    expect(parseJpegSegments(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toEqual([]);
  });
  it('handles non-jpeg input', () => {
    expect(parseJpegSegments(new Uint8Array([1, 2, 3]).buffer)).toEqual([]);
  });
});
