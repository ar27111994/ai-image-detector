import { describe, expect, it } from 'vitest';
import {
  preprocessRgba,
  resizeRgbaBilinear,
  rgbaToChwTensor,
} from '../../src/shared/preprocess.js';
import { softmaxProbability } from '../../src/shared/math.js';

describe('resizeRgbaBilinear', () => {
  it('returns a copy when dimensions already match', () => {
    const src = new Uint8ClampedArray([10, 20, 30, 255]);
    const out = resizeRgbaBilinear(src, 1, 1, 1, 1);
    expect([...out]).toEqual([10, 20, 30, 255]);
    expect(out).not.toBe(src);
  });

  it('rejects wrong input length', () => {
    expect(() => resizeRgbaBilinear(new Uint8ClampedArray(8), 1, 1, 2, 2)).toThrow(RangeError);
  });

  it('upscales a 2x2 checkerboard smoothly', () => {
    // 2x2: black, white / white, black (opaque)
    const src = new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
    ]);
    const out = resizeRgbaBilinear(src, 2, 2, 4, 4);
    expect(out.length).toBe(4 * 4 * 4);
    // Corners should be near the source corner colors.
    expect(out[0]).toBeLessThan(80); // top-left ~ black
    expect(out[(0 * 4 + 3) * 4]).toBeGreaterThan(175); // top-right ~ white
    expect(out[(3 * 4 + 0) * 4]).toBeGreaterThan(175); // bottom-left ~ white
    expect(out[(3 * 4 + 3) * 4]).toBeLessThan(80); // bottom-right ~ black
    // Center should be a blend.
    const center = out[(1 * 4 + 1) * 4];
    expect(center).toBeGreaterThan(60);
    expect(center).toBeLessThan(195);
  });

  it('downscales a solid color image to the same color', () => {
    const w = 8;
    const h = 8;
    const src = new Uint8ClampedArray(w * h * 4).fill(0);
    for (let i = 0; i < w * h; i++) {
      src[i * 4] = 200;
      src[i * 4 + 1] = 100;
      src[i * 4 + 2] = 50;
      src[i * 4 + 3] = 255;
    }
    const out = resizeRgbaBilinear(src, w, h, 4, 4);
    for (let i = 0; i < 16; i++) {
      expect(out[i * 4]).toBe(200);
      expect(out[i * 4 + 1]).toBe(100);
      expect(out[i * 4 + 2]).toBe(50);
    }
  });
});

describe('rgbaToChwTensor', () => {
  it('produces CHW planar layout with normalization', () => {
    // 2x1 image: red pixel, green pixel
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const { data, dims } = rgbaToChwTensor(rgba, 2, 1, { mean: [0, 0, 0], std: [1, 1, 1] });
    expect(dims).toEqual([1, 3, 1, 2]);
    expect(data.length).toBe(6);
    // R plane: [1, 0]; G plane: [0, 1]; B plane: [0, 0]
    expect(data[0]).toBeCloseTo(1);
    expect(data[1]).toBeCloseTo(0);
    expect(data[2]).toBeCloseTo(0);
    expect(data[3]).toBeCloseTo(1);
    expect(data[4]).toBeCloseTo(0);
    expect(data[5]).toBeCloseTo(0);
  });

  it('applies mean/std after 1/255 rescale', () => {
    const rgba = new Uint8ClampedArray([127.5 * 2, 0, 0, 255].map(Math.round)); // R=255
    const { data } = rgbaToChwTensor(rgba, 1, 1, { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] });
    expect(data[0]).toBeCloseTo((1 - 0.5) / 0.5); // R -> 1.0
    expect(data[1]).toBeCloseTo((0 - 0.5) / 0.5); // G -> -1.0
  });

  it('rejects mismatched buffer size', () => {
    expect(() => rgbaToChwTensor(new Uint8ClampedArray(3), 1, 1)).toThrow(RangeError);
  });
});

describe('preprocessRgba', () => {
  it('resizes then normalizes to the model input size', () => {
    const rgba = new Uint8ClampedArray(100 * 50 * 4).fill(128);
    const { data, dims } = preprocessRgba(rgba, 100, 50, {
      inputSize: 224,
      mean: [0.5, 0.5, 0.5],
      std: [0.5, 0.5, 0.5],
    });
    expect(dims).toEqual([1, 3, 224, 224]);
    expect(data.length).toBe(3 * 224 * 224);
    // 128/255 ≈ 0.502 -> normalized ≈ 0.0039
    expect(Math.abs(data[0])).toBeLessThan(0.01);
  });
});

describe('softmaxProbability', () => {
  it('returns ~1 when AI logit dominates', () => {
    expect(softmaxProbability([0, 10], 1)).toBeCloseTo(0.99995, 4);
  });
  it('returns ~0 when real logit dominates', () => {
    expect(softmaxProbability([10, 0], 1)).toBeCloseTo(0.0000454, 4);
  });
  it('returns 0.5 for a tie', () => {
    expect(softmaxProbability([3, 3], 1)).toBeCloseTo(0.5);
  });
  it('is numerically stable for large logits', () => {
    expect(softmaxProbability([1000, 1001], 1)).toBeCloseTo(0.7310586, 4);
  });
  it('respects aiLogitIndex=0', () => {
    expect(softmaxProbability([10, 0], 0)).toBeCloseTo(0.99995, 4);
  });
  it('rejects single-logit output', () => {
    expect(() => softmaxProbability([1], 1)).toThrow(RangeError);
  });
});
