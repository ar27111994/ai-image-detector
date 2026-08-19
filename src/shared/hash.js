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
 * Content-addressed key for an image, used for the analysis LRU cache.
 * Hashes the COMPLETE buffer: the cache key decides whether two images share a verdict, so it
 * must be collision-resistant. Sampling head/middle/tail windows would give two same-length
 * images that differ only outside those windows the same key, returning one image's verdict for
 * the other. Inputs are already capped at MAX_IMAGE_BYTES and inference is far costlier than one
 * SHA-256 pass, so the full hash is the correct tradeoff.
 *
 * @param {ArrayBuffer} buffer full image bytes
 * @returns {Promise<string>} cache key (`<byteLength>:<sha256-hex prefix>`)
 */
export async function imageContentKey(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  if (len === 0) return 'empty';
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest.slice(0, 16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${len}:${hex}`;
}
