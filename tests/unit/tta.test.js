import { describe, expect, it } from 'vitest';
import { computeViewRects, meanLogits } from '../../src/shared/tta.js';

describe('tta.computeViewRects', () => {
  it('returns only the full frame for small images (< 2x input)', () => {
    const rects = computeViewRects(200, 200, 256);
    expect(rects).toEqual([{ sx: 0, sy: 0, sw: 200, sh: 200 }]);
  });

  it('returns full frame + 5-crop grid for large images', () => {
    const rects = computeViewRects(1024, 1024, 256);
    expect(rects.length).toBe(6);
    expect(rects[0]).toEqual({ sx: 0, sy: 0, sw: 1024, sh: 1024 }); // full
    // corners + center
    expect(rects).toContainEqual({ sx: 0, sy: 0, sw: 512, sh: 512 }); // top-left
    expect(rects).toContainEqual({ sx: 512, sy: 0, sw: 512, sh: 512 }); // top-right
    expect(rects).toContainEqual({ sx: 0, sy: 512, sw: 512, sh: 512 }); // bottom-left
    expect(rects).toContainEqual({ sx: 512, sy: 512, sw: 512, sh: 512 }); // bottom-right
  });

  it('crop rects stay within image bounds', () => {
    for (const [w, h] of [
      [800, 600],
      [1024, 512],
      [2000, 1500],
      [513, 511],
    ]) {
      for (const r of computeViewRects(w, h, 256)) {
        expect(r.sx).toBeGreaterThanOrEqual(0);
        expect(r.sy).toBeGreaterThanOrEqual(0);
        expect(r.sx + r.sw).toBeLessThanOrEqual(w);
        expect(r.sy + r.sh).toBeLessThanOrEqual(h);
      }
    }
  });

  it('handles non-square images', () => {
    const rects = computeViewRects(1600, 800, 256);
    expect(rects.length).toBe(6);
    for (const r of rects) {
      expect(r.sx + r.sw).toBeLessThanOrEqual(1600);
      expect(r.sy + r.sh).toBeLessThanOrEqual(800);
    }
  });
});

describe('tta.meanLogits', () => {
  it('averages logits element-wise', () => {
    const out = meanLogits([
      [1, 3],
      [3, 5],
      [2, 1],
    ]);
    expect(out[0]).toBeCloseTo(2, 10);
    expect(out[1]).toBeCloseTo(3, 10);
  });

  it('returns the same logits for a single view', () => {
    expect(meanLogits([[4, -2]])).toEqual([4, -2]);
  });

  it('throws on empty input', () => {
    expect(() => meanLogits([])).toThrow(RangeError);
  });

  it('throws on inconsistent class counts', () => {
    expect(() =>
      meanLogits([
        [1, 2],
        [1, 2, 3],
      ]),
    ).toThrow(RangeError);
  });
});
