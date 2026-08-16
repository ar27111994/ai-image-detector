import { describe, expect, it } from 'vitest';
import { clamp01, softmaxProbability } from '../../src/shared/math.js';

describe('clamp01', () => {
  it('passes through values already in range', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });
  it('clamps below-range values to 0', () => {
    expect(clamp01(-0.001)).toBe(0);
    expect(clamp01(-100)).toBe(0);
  });
  it('clamps above-range values to 1', () => {
    expect(clamp01(1.0001)).toBe(1);
    expect(clamp01(42)).toBe(1);
  });
});

describe('softmaxProbability', () => {
  it('returns ~1 when the AI logit dominates', () => {
    expect(softmaxProbability([0, 10], 1)).toBeCloseTo(0.99995, 4);
  });
  it('returns ~0 when the other logit dominates', () => {
    expect(softmaxProbability([10, 0], 1)).toBeCloseTo(0.0000454, 4);
  });
  it('returns 0.5 for a tie', () => {
    expect(softmaxProbability([3, 3], 1)).toBeCloseTo(0.5);
  });
  it('is numerically stable for large-magnitude logits', () => {
    expect(softmaxProbability([1000, 1001], 1)).toBeCloseTo(0.7310586, 4);
  });
  it('honours aiIndex = 0', () => {
    expect(softmaxProbability([10, 0], 0)).toBeCloseTo(0.99995, 4);
  });
  it('rejects a single-logit vector', () => {
    expect(() => softmaxProbability([1], 1)).toThrow(RangeError);
  });
});
