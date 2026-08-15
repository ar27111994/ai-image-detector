/**
 * Byte-level container parsers for image formats. All pure functions over ArrayBuffer/Uint8Array.
 * Bounds-checked throughout — malformed input returns partial results, never throws.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Normalize an ArrayBuffer|Uint8Array to a Uint8Array view (no copy when already a view). */
export function bytesOf(buffer) {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

/** True if `bytes` starts with `magic` at `offset`. */
export function hasMagic(bytes, magic, offset = 0) {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/** Detect container format from magic bytes. */
export function detectFormat(buffer) {
  const b = bytesOf(buffer);
  if (b.length < 12) return 'unknown';
  if (hasMagic(b, PNG_MAGIC)) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (hasMagic(b, [0x52, 0x49, 0x46, 0x46]) && hasMagic(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }
  if (hasMagic(b, [0x47, 0x49, 0x46, 0x38])) return 'gif'; // GIF87a/89a
  if (hasMagic(b, [0x66, 0x74, 0x79, 0x70], 4)) return 'avif-or-bmff';
  return 'unknown';
}

/**
 * Parse PNG into chunks: [{ type, data(Uint8Array), offset }]. Stops at IEND or EOF.
 */
export function parsePngChunks(buffer) {
  const b = bytesOf(buffer);
  if (!hasMagic(b, PNG_MAGIC)) return [];
  const chunks = [];
  let offset = 8;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (offset + 12 <= b.length) {
    const length = view.getUint32(offset, false);
    if (length > b.length - offset - 12) break; // corrupt: declared length exceeds remaining
    const type = String.fromCharCode(b[offset + 4], b[offset + 5], b[offset + 6], b[offset + 7]);
    const data = b.slice(offset + 8, offset + 8 + length);
    chunks.push({ type, data, offset });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/**
 * Parse JPEG into segments: [{ marker, name, data(Uint8Array) }]. Stops at SOS (scan data).
 */
export function parseJpegSegments(buffer) {
  const b = bytesOf(buffer);
  if (!(b[0] === 0xff && b[1] === 0xd8)) return [];
  const segments = [];
  let offset = 2;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) {
      offset++;
      continue; // tolerate padding
    }
    const marker = b[offset + 1];
    // Standalone markers (no length): SOI(0xD8), EOI(0xD9), RST(0xD0-D7), TEM(0x01)
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      offset += 2;
      if (marker === 0xd9) break;
      continue;
    }
    const length = view.getUint16(offset + 2, false);
    if (length < 2 || offset + 2 + length > b.length) break;
    const data = b.slice(offset + 4, offset + 2 + length);
    segments.push({ marker, name: `APP${marker - 0xe0}`, data });
    offset += 2 + length;
    if (marker === 0xda) break; // SOS — image data follows
  }
  return segments;
}

/**
 * Parse WebP RIFF chunks: [{ fourcc, data(Uint8Array) }].
 */
export function parseWebpChunks(buffer) {
  const b = bytesOf(buffer);
  if (!hasMagic(b, [0x52, 0x49, 0x46, 0x46]) || !hasMagic(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return [];
  }
  const chunks = [];
  let offset = 12;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (offset + 8 <= b.length) {
    const fourcc = String.fromCharCode(b[offset], b[offset + 1], b[offset + 2], b[offset + 3]);
    const size = view.getUint32(offset + 4, true); // little-endian
    if (offset + 8 + size > b.length) break;
    chunks.push({ fourcc, data: b.slice(offset + 8, offset + 8 + size) });
    offset += 8 + size + (size % 2); // chunks are 2-byte aligned
  }
  return chunks;
}

/** Extract ASCII-ish printable strings from a byte range (for claim_generator scanning). */
export function extractStrings(data, minLength = 4, maxLength = 256) {
  const b = bytesOf(data);
  const out = [];
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const printable = i < b.length && b[i] >= 0x20 && b[i] <= 0x7e;
    if (printable && start === -1) start = i;
    if (!printable && start !== -1) {
      const len = i - start;
      if (len >= minLength) {
        out.push(new TextDecoder('latin1').decode(b.slice(start, Math.min(i, start + maxLength))));
      }
      start = -1;
    }
  }
  return out;
}
