import { describe, expect, it } from 'vitest';
import {
  balancedAccuracyWithCi,
  confusionAtThreshold,
  perGroupMetrics,
  thresholdSweep,
  wilsonInterval,
} from '../../src/shared/metrics.js';

const rows = (specs) => specs.map(([label, score]) => ({ label, score }));

describe('confusionAtThreshold', () => {
  it('computes a perfect classifier as BA=1', () => {
    const r = confusionAtThreshold(
      rows([
        ['fake', 0.9],
        ['fake', 0.8],
        ['real', 0.1],
        ['real', 0.2],
      ]),
      0.65,
    );
    expect(r.balancedAccuracy).toBe(1);
    expect(r.tp).toBe(2);
    expect(r.tn).toBe(2);
  });

  it('gives equal weight to classes regardless of counts (balanced)', () => {
    // 100 real all correct, 2 fake of which 1 correct -> TPR .5, TNR 1 -> BA .75
    const data = [...Array(100).fill(['real', 0.1]), ['fake', 0.9], ['fake', 0.1]];
    const r = confusionAtThreshold(rows(data), 0.65);
    expect(r.balancedAccuracy).toBeCloseTo(0.75);
  });

  it('threshold is inclusive (score == threshold predicts AI)', () => {
    const r = confusionAtThreshold(rows([['fake', 0.65]]), 0.65);
    expect(r.tp).toBe(1);
  });

  it('excludes errored rows and counts them', () => {
    const r = confusionAtThreshold(
      [
        { label: 'fake', score: null, error: 'decode' },
        { label: 'fake', score: Number.NaN },
        { label: 'real', score: 0.2 },
      ],
      0.65,
    );
    expect(r.errors).toBe(2);
    expect(r.negatives).toBe(1);
    expect(r.positives).toBe(0);
  });

  it('handles empty input without NaN', () => {
    const r = confusionAtThreshold([], 0.65);
    expect(r.balancedAccuracy).toBe(0);
    expect(r.tpr).toBe(0);
    expect(r.tnr).toBe(0);
  });
});

describe('wilsonInterval', () => {
  it('is [0,0] for empty samples', () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });
  it('centers near the proportion for large n', () => {
    const [lo, hi] = wilsonInterval(80, 100);
    expect(lo).toBeGreaterThan(0.7);
    expect(hi).toBeLessThan(0.9);
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
  });
  it('never exceeds [0,1]', () => {
    const [lo, hi] = wilsonInterval(100, 100);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });
});

describe('balancedAccuracyWithCi', () => {
  it('returns a CI that brackets the point estimate', () => {
    const r = balancedAccuracyWithCi(
      rows([
        ['fake', 0.9],
        ['fake', 0.7],
        ['real', 0.2],
        ['real', 0.8],
      ]),
      0.65,
    );
    expect(r.ci95[0]).toBeLessThanOrEqual(r.balancedAccuracy);
    expect(r.ci95[1]).toBeGreaterThanOrEqual(r.balancedAccuracy);
  });
});

describe('thresholdSweep / perGroupMetrics', () => {
  it('sweeps thresholds in order', () => {
    const out = thresholdSweep(rows([['fake', 0.5]]), [0.3, 0.7]);
    expect(out.map((r) => r.threshold)).toEqual([0.3, 0.7]);
    expect(out[0].tp).toBe(1);
    expect(out[1].fn).toBe(1);
  });

  it('computes per-group metrics', () => {
    const data = [
      { label: 'fake', score: 0.9, generator: 'flux' },
      { label: 'fake', score: 0.1, generator: 'flux' },
      { label: 'fake', score: 0.9, generator: 'sd15' },
    ];
    const groups = perGroupMetrics(data, (r) => r.generator, 0.65);
    const flux = groups.find((g) => g.group === 'flux');
    const sd = groups.find((g) => g.group === 'sd15');
    expect(flux.tpr).toBe(0.5);
    expect(sd.tpr).toBe(1);
    expect(groups[0].count).toBe(2); // sorted by count desc
  });
});
