/**
 * SHA-256 hashing helpers (WebCrypto). Used for weight verification and image content hashing.
 * WebCrypto is available in service workers, offscreen documents, and pages.
 */

/**
 * SHA-256 hex of an ArrayBuffer/TypedArray/Blob.
 * @param {ArrayBuffer | Uint8Array | Blob} input
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256Hex(input) {
  let buffer;
  if (input instanceof Blob) {
    buffer = await input.arrayBuffer();
  } else if (ArrayBuffer.isView(input)) {
    buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  } else {
    buffer = input;
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fast content-addressed key for an image, used for the analysis LRU cache.
 * Not cryptographic by design requirement — just a stable, collision-resistant key from
 * size + sampled bytes + a short sha of the first/last chunks.
 *
 * @param {ArrayBuffer} buffer full image bytes
 * @returns {Promise<string>} cache key
 */
export async function imageContentKey(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  if (len === 0) return 'empty';
  // Sample up to 3 windows (head, middle, tail) to keep hashing O(1) in image size.
  const windowSize = Math.min(4096, Math.ceil(len / 3));
  const parts = [bytes.slice(0, windowSize)];
  if (len > windowSize) {
    const mid = Math.floor((len - windowSize) / 2);
    parts.push(bytes.slice(mid, mid + windowSize));
    parts.push(bytes.slice(len - windowSize));
  }
  const combined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    combined.set(p, offset);
    offset += p.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', combined.buffer);
  const hex = [...new Uint8Array(digest.slice(0, 12))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${len}:${hex}`;
}
