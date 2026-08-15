import { describe, expect, it } from 'vitest';
import { expectedCalibrationError } from '../../src/shared/metrics.js';

describe('metrics.expectedCalibrationError', () => {
  it('is ~0 for a perfectly calibrated perfect classifier', () => {
    // All fake at 0.99, all real at 0.01 -> high confidence, 100% correct
    const rows = [
      ...Array(50).fill({ label: 'fake', score: 0.99 }),
      ...Array(50).fill({ label: 'real', score: 0.01 }),
    ];
    const { ece } = expectedCalibrationError(rows);
    // confidence 0.99 with 100% accuracy => ECE = |1.00 - 0.99| = 0.01 (near-perfectly calibrated)
    expect(ece).toBeCloseTo(0.01, 2);
    expect(ece).toBeLessThan(0.02);
  });

  it('is high for an overconfident wrong classifier', () => {
    // Confidently wrong: fake scored 0.99 but labeled real (mislabeled)
    const rows = [
      ...Array(50).fill({ label: 'real', score: 0.99 }), // predicts fake, is real -> wrong
      ...Array(50).fill({ label: 'fake', score: 0.01 }), // predicts real, is fake -> wrong
    ];
    const { ece } = expectedCalibrationError(rows);
    expect(ece).toBeGreaterThan(0.4);
  });

  it('returns 0 for empty/all-error input', () => {
    expect(expectedCalibrationError([]).ece).toBe(0);
    expect(expectedCalibrationError([{ label: 'fake', score: null, error: 'x' }]).ece).toBe(0);
  });

  it('clamps out-of-range scores', () => {
    const rows = [
      { label: 'fake', score: 1.5 },
      { label: 'real', score: -0.2 },
    ];
    expect(() => expectedCalibrationError(rows)).not.toThrow();
  });
});
