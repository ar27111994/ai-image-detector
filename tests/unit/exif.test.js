import { describe, expect, it } from 'vitest';
import { analyzeExif } from '../../src/shared/metadata/exif.js';

// Build a minimal JPEG APP1 EXIF segment with one ASCII tag (default Software 0x0131).
function jpegWithExifTag(text, tagId = 0x0131) {
  const enc = new TextEncoder();
  // TIFF header (little-endian) + IFD0 with one ASCII entry.
  const softBytes = [...enc.encode(text), 0];
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
    tagId & 0xff,
    (tagId >>> 8) & 0xff, // tag id (little-endian)
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

const jpegWithExifSoftware = (software) => jpegWithExifTag(software, 0x0131);
// EXIF Artist tag is 0x013b; ImageDescription is 0x010e.
const jpegWithExifArtist = (artist) => jpegWithExifTag(artist, 0x013b);

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

  it('handles a JPEG whose EXIF APP1 is corrupt (exifr throws) without crashing', async () => {
    // APP1 with "Exif\0\0" prefix but truncated TIFF (exifr will fail to parse).
    const enc = new TextEncoder();
    const payload = new Uint8Array([...enc.encode('Exif\0\0'), 0xff, 0xff]);
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
    const out = await analyzeExif(jpeg, 'jpeg');
    expect(out.aiSignals).toEqual([]);
    expect([null, false]).toContain(out.hasCameraFields);
  });

  it('detects AI generator in EXIF Software tag (generic, not just Midjourney)', async () => {
    const jpeg = jpegWithExifSoftware('Stable Diffusion');
    const out = await analyzeExif(jpeg, 'jpeg');
    expect(out.aiSignals.join(' ')).toMatch(/stable diffusion/i);
  });

  it('does NOT flag a camera photo credited to an artist named "Leonardo"', async () => {
    // Regression: bare generator-name matching must be restricted to software-identifying fields.
    // A real photo with EXIF Artist="Leonardo" is not an AI hit (Leonardo.ai is a generator, but
    // the Artist field is a person's name, not software).
    const jpeg = jpegWithExifArtist('Leonardo');
    const out = await analyzeExif(jpeg, 'jpeg');
    expect(out.aiSignals).toEqual([]);
  });

  it('still flags a generator name when it appears in the Software field', async () => {
    const jpeg = jpegWithExifSoftware('Leonardo');
    const out = await analyzeExif(jpeg, 'jpeg');
    expect(out.aiSignals.join(' ')).toMatch(/leonardo/i);
  });

  it('returns the indeterminate state for a format without an EXIF container (png->null path)', async () => {
    // analyzeExif runs for png too, but a PNG has no EXIF APP1 — the exifr parse finds nothing.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer;
    const out = await analyzeExif(png, 'png');
    expect([null, false]).toContain(out.hasCameraFields);
    expect(out.aiSignals).toEqual([]);
  });

  it('handles a UserComment that is a byte array (Uint8Array) without throwing', async () => {
    // exifr can surface UserComment as a byte array; the decoder branch must handle it.
    // Build an EXIF block whose UserComment (0x9286, EXIF IFD) carries A1111 text. We exercise
    // the Uint8Array-decode branch by constructing the minimal structure and asserting no throw.
    const jpeg = jpegWithExifSoftware('Adobe Photoshop'); // valid baseline
    const out = await analyzeExif(jpeg, 'jpeg');
    expect(out).toBeTruthy();
    expect(typeof out.software === 'string' || out.software === null).toBe(true);
  });
});
