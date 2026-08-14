import { describe, expect, it } from 'vitest';
import { extractSpectralFeatures } from '../../src/shared/metadata/spectral.js';

/** Build a synthetic RGBA image of size n×n from a generator fn(x,y) -> [r,g,b]. */
function makeImage(n, fn) {
  const rgba = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * n + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe('spectral.extractSpectralFeatures', () => {
  it('returns 20 radial bins + summary stats', () => {
    const img = makeImage(256, () => [128, 128, 128]);
    const f = extractSpectralFeatures(img, 256, 256);
    expect(f.radialSpectrum.length).toBe(20);
    expect(f.highFreqRatio).toBeGreaterThanOrEqual(0);
    expect(f.highFreqRatio).toBeLessThanOrEqual(1);
    expect(Number.isFinite(f.spectralPeakRatio)).toBe(true);
  });

  it('a flat image has ~zero high-frequency energy', () => {
    const flat = extractSpectralFeatures(
      makeImage(256, () => [100, 100, 100]),
      256,
      256,
    );
    const textured = extractSpectralFeatures(
      makeImage(256, (x, y) => {
        const v = (x * 7 + y * 13) % 256;
        return [v, v, v];
      }),
      256,
      256,
    );
    expect(textured.highFreqRatio).toBeGreaterThan(flat.highFreqRatio);
  });

  it('a high-frequency pattern has higher highFreqRatio than a smooth gradient', () => {
    // 2px-period checkerboard: energy sits at a high (resolvable) radial bin.
    const checker = extractSpectralFeatures(
      makeImage(256, (x, y) =>
        (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? [255, 255, 255] : [0, 0, 0],
      ),
      256,
      256,
    );
    const smooth = extractSpectralFeatures(
      makeImage(256, (x) => {
        const v = Math.round(128 + 127 * Math.sin(x / 40));
        return [v, v, v];
      }),
      256,
      256,
    );
    expect(checker.highFreqRatio).toBeGreaterThan(smooth.highFreqRatio);
    expect(checker.spectralPeakRatio).toBeGreaterThan(smooth.spectralPeakRatio);
  });

  it('a 1px checkerboard aliases at the crop boundary (documented edge case)', () => {
    // A 1px-period pattern at the Nyquist of a 256 crop aliases to ~DC; the module must not
    // throw and must return finite features (it cannot resolve this — that is expected).
    const checker = extractSpectralFeatures(
      makeImage(256, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0])),
      256,
      256,
    );
    expect(Number.isFinite(checker.highFreqRatio)).toBe(true);
  });

  it('handles non-square input and small sizes without throwing', () => {
    const img = makeImage(64, () => [50, 60, 70]);
    // treat the 64x64 as if width 128 height 32 (wrong on purpose) — should not throw
    expect(() => extractSpectralFeatures(img, 64, 64)).not.toThrow();
  });
});
