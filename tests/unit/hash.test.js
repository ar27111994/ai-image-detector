import { describe, expect, it } from 'vitest';
import { imageContentKey, sha256Hex } from '../../src/shared/hash.js';

describe('hash.sha256Hex', () => {
  it('hashes an ArrayBuffer to known SHA-256', async () => {
    // "abc" -> ba7816bf...
    const buf = new TextEncoder().encode('abc').buffer;
    expect(await sha256Hex(buf)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('accepts Uint8Array and Blob', async () => {
    const bytes = new Uint8Array([97, 98, 99]);
    const fromU8 = await sha256Hex(bytes);
    const fromBlob = await sha256Hex(new Blob([bytes]));
    expect(fromU8).toBe(fromBlob);
  });

  it('handles empty input', async () => {
    const h = await sha256Hex(new ArrayBuffer(0));
    expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('hash.imageContentKey', () => {
  it('is deterministic for identical bytes', async () => {
    const a = new Uint8Array(10000).fill(7).buffer;
    const b = new Uint8Array(10000).fill(7).buffer;
    expect(await imageContentKey(a)).toBe(await imageContentKey(b));
  });

  it('differs for different content', async () => {
    const a = new Uint8Array(10000).fill(7).buffer;
    const b = new Uint8Array(10000).fill(8).buffer;
    expect(await imageContentKey(a)).not.toBe(await imageContentKey(b));
  });

  it('differs for different lengths with same prefix', async () => {
    const a = new Uint8Array(100).fill(1).buffer;
    const b = new Uint8Array(100000).fill(1).buffer;
    expect(await imageContentKey(a)).not.toBe(await imageContentKey(b));
  });

  it('handles tiny and empty buffers', async () => {
    expect(await imageContentKey(new ArrayBuffer(0))).toBe('empty');
    expect(await imageContentKey(new Uint8Array([1]).buffer)).toBeTruthy();
  });
});
