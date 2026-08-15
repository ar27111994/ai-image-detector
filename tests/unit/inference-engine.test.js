/**
 * Unit tests for the inference engine's pure output-scoring logic (scoreFromOutput).
 * The ORT session lifecycle is covered by e2e; this covers the score math in isolation.
 */
import { describe, expect, it } from 'vitest';

// inference-engine.js imports onnxruntime-web and touches chrome APIs at module scope via
// configureOrt only when called — importing is safe because those are inside functions.
// scoreFromOutput is exported and pure.
const { scoreFromOutput } = await import('../../src/offscreen/inference-engine.js');

describe('inference-engine.scoreFromOutput', () => {
  it('maps p_real outputType to 1 - p_real (AI probability)', () => {
    const spec = { outputType: 'p_real' };
    expect(scoreFromOutput([0.01], spec)).toBeCloseTo(0.99, 5);
    expect(scoreFromOutput([0.99], spec)).toBeCloseTo(0.01, 5);
  });

  it('maps 2-class logits via softmax at aiLogitIndex', () => {
    // id2label {0: artificial, 1: real} -> aiLogitIndex 0
    const spec = { aiLogitIndex: 0 };
    // strong AI logit
    expect(scoreFromOutput([5, -5], spec)).toBeCloseTo(0.99995, 4);
    // strong real logit
    expect(scoreFromOutput([-5, 5], spec)).toBeCloseTo(0.0000454, 4);
    // tie
    expect(scoreFromOutput([1, 1], spec)).toBeCloseTo(0.5, 5);
  });

  it('respects aiLogitIndex=1 (Real,Fake layout)', () => {
    const spec = { aiLogitIndex: 1 };
    // softmax(e^0, e^5) at index 1 = e^5 / (e^0 + e^5) ≈ 0.99331
    expect(scoreFromOutput([0, 5], spec)).toBeCloseTo(0.99331, 4);
    expect(scoreFromOutput([5, 0], spec)).toBeCloseTo(0.00669, 4);
  });

  it('clamps to [0,1] and handles extreme logits without overflow', () => {
    const spec = { aiLogitIndex: 0 };
    const out = scoreFromOutput([1000, -1000], spec);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(1);
    expect(Number.isFinite(out)).toBe(true);
  });

  it('handles negative and zero logits symmetrically', () => {
    const spec = { aiLogitIndex: 1 };
    expect(scoreFromOutput([0, 0], spec)).toBeCloseTo(0.5, 5);
    expect(scoreFromOutput([-10, -10], spec)).toBeCloseTo(0.5, 5);
  });
});
