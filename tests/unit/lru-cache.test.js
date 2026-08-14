import { describe, expect, it } from 'vitest';
import { LruCache } from '../../src/shared/lru-cache.js';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const c = new LruCache(3);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.has('a')).toBe(true);
  });

  it('evicts least-recently-used beyond capacity', () => {
    const c = new LruCache(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // evicts 'a'
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
  });

  it('a get refreshes recency', () => {
    const c = new LruCache(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // 'a' now most-recent
    c.set('c', 3); // evicts 'b', not 'a'
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
  });

  it('updating an existing key does not grow size', () => {
    const c = new LruCache(2);
    c.set('a', 1);
    c.set('a', 2);
    expect(c.size).toBe(1);
    expect(c.get('a')).toBe(2);
  });

  it('rejects invalid capacity', () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(-1)).toThrow(RangeError);
    expect(() => new LruCache(1.5)).toThrow(RangeError);
  });

  it('clear empties the cache', () => {
    const c = new LruCache(4);
    c.set('a', 1);
    c.clear();
    expect(c.size).toBe(0);
  });
});
