import { describe, expect, it } from 'vitest';
import { createRng, seededShuffle } from '../../src/shared/rng.js';

describe('rng', () => {
  it('is deterministic for a fixed seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('differs across seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('seededShuffle preserves elements and is deterministic', () => {
    const arr = Array.from({ length: 50 }, (_, i) => i);
    const s1 = seededShuffle(arr, 7);
    const s2 = seededShuffle(arr, 7);
    expect(s1).toEqual(s2);
    expect(s1.slice().sort((x, y) => x - y)).toEqual(arr);
    expect(s1).not.toEqual(arr); // astronomically unlikely to identity-shuffle
  });
});
