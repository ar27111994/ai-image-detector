import { describe, expect, it } from 'vitest';
import { analyzeExif } from '../../src/shared/metadata/exif.js';

// Build a minimal JPEG APP1 EXIF segment with a Software tag.
function jpegWithExifSoftware(software) {
  const enc = new TextEncoder();
  // TIFF header (little-endian) + IFD0 with one entry: Software (0x0131, ASCII)
  const softBytes = [...enc.encode(software), 0];
  const ifdOffset = 8;
  const entryCount = 1;
  const valueOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const tiff = [
    0x49,
    0x49,
    0x2a,
    0x00, // II + magic
    ifdOffset,
    0,
    0,
    0, // IFD0 offset
    entryCount & 0xff,
    0, // 1 entry
    0x31,
    0x01, // tag 0x0131 Software
    0x02,
    0x00, // type ASCII
    softBytes.length & 0xff,
    0,
    0,
    0, // count
    valueOffset & 0xff,
    0,
    0,
    0, // value offset
    0,
    0,
    0,
    0, // next IFD
  ];
  while (tiff.length < valueOffset) tiff.push(0);
  tiff.push(...softBytes);
  const exifPayload = [...enc.encode('Exif\0\0'), ...tiff];
  const segLen = exifPayload.length + 2;
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xe1,
    (segLen >>> 8) & 0xff,
    segLen & 0xff,
    ...exifPayload,
    0xff,
    0xd9,
  ];
  return new Uint8Array(bytes).buffer;
}

describe('exif.analyzeExif', () => {
  it('flags AI software tag (Midjourney)', async () => {
    const jpeg = jpegWithExifSoftware('Midjourney');
    const out = await analyzeExif(jpeg, 'jpeg');
    expect(out.aiSignals.length).toBeGreaterThan(0);
    expect(out.aiSignals.join(' ')).toMatch(/midjourney/i);
  });

  it('reports no camera fields for a software-only EXIF', async () => {
    const out = await analyzeExif(jpegWithExifSoftware('Adobe Photoshop'), 'jpeg');
    expect(out.hasCameraFields).toBe(false);
  });

  it('returns null camera state for non-image formats', async () => {
    const out = await analyzeExif(new Uint8Array([1, 2, 3]).buffer, 'unknown');
    expect(out.hasCameraFields).toBeNull();
    expect(out.aiSignals).toEqual([]);
  });

  it('never throws on a bare JPEG with no EXIF', async () => {
    const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    const out = await analyzeExif(bare, 'jpeg');
    expect(out.hasCameraFields).toBe(false);
    expect(out.aiSignals).toEqual([]);
  });
});
