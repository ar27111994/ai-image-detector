/**
 * Concurrency / race-condition tests for the shared primitives and caches.
 * (Browser-context races — offscreen creation, session init — are covered by e2e; these test
 * the pure units under concurrent load.)
 */
import { describe, expect, it } from 'vitest';
import { LruCache } from '../../src/shared/lru-cache.js';
import { nextId } from '../../src/shared/protocol.js';
import { imageContentKey } from '../../src/shared/hash.js';

describe('concurrency: LruCache under parallel churn', () => {
  it('stays consistent under 1000 interleaved set/get/delete', async () => {
    const c = new LruCache(50);
    const ops = [];
    for (let i = 0; i < 1000; i++) {
      const key = `k${i % 100}`;
      ops.push(Promise.resolve().then(() => c.set(key, i)));
      if (i % 3 === 0) ops.push(Promise.resolve().then(() => c.get(key)));
      if (i % 7 === 0) ops.push(Promise.resolve().then(() => c.delete(`k${i % 50}`)));
    }
    await Promise.all(ops);
    expect(c.size).toBeLessThanOrEqual(50);
    // Invariant: keys present are retrievable
    for (const k of [...c.map.keys()]) expect(c.get(k)).toBeDefined();
  });

  it('never exceeds capacity under concurrent writes', async () => {
    const c = new LruCache(10);
    await Promise.all(
      Array.from({ length: 500 }, (_, i) => Promise.resolve().then(() => c.set(`k${i}`, i))),
    );
    expect(c.size).toBe(10);
  });
});

describe('concurrency: id generation uniqueness', () => {
  it('generates unique ids even when called in the same millisecond', async () => {
    const ids = new Set();
    await Promise.all(
      Array.from({ length: 5000 }, () => Promise.resolve().then(() => ids.add(nextId('t')))),
    );
    expect(ids.size).toBe(5000);
  });
});

describe('concurrency: content hashing is stable and order-independent', () => {
  it('same bytes -> same key regardless of call timing', async () => {
    const buf = new Uint8Array(100000).map((_, i) => i & 0xff).buffer;
    const keys = await Promise.all(Array.from({ length: 20 }, () => imageContentKey(buf)));
    expect(new Set(keys).size).toBe(1);
  });
});

describe('stress: hashing large payloads', () => {
  it('imageContentKey hashes the full 32MB buffer (collision-resistant) in reasonable time', async () => {
    const big = new Uint8Array(32 * 1024 * 1024).buffer;
    const t0 = performance.now();
    const key = await imageContentKey(big);
    const ms = performance.now() - t0;
    expect(key).toBeTruthy();
    // Full-buffer SHA-256 (collision-resistant by design; the cache key decides verdict sharing).
    // WebCrypto does this at ~GB/s; 5s is a generous bound that still catches a pathological blowup.
    expect(ms).toBeLessThan(5000);
  });
});
