/**
 * Frequency-domain (spectral) features via 2D FFT over a grayscale center crop.
 *
 * Diffusion/GAN generators leave characteristic spectral signatures: elevated high-frequency
 * energy and periodic peaks at the VAE upsampling stride. These features are a WEAK learner
 * (lab precision ~65-80%, lower after web recompression) — they feed the fusion layer as a
 * nudge, never a standalone verdict. (Corvi et al., ICASSP 2023; Wang et al., CVPR 2020.)
 *
 * Uses fft.js (MIT). Runs in the offscreen document (no DOM dependency).
 */
import FFT from 'fft.js';

const CROP_SIZE = 256; // power of two for radix-2 FFT
const RADIAL_BINS = 20;

let fft = null;
function getFft(size) {
  if (!fft || fft.size !== size) fft = new FFT(size);
  return fft;
}

/**
 * Extract spectral features from an RGBA pixel buffer.
 * @param {Uint8ClampedArray|Uint8Array} rgba interleaved RGBA
 * @param {number} width
 * @param {number} height
 * @returns {{ radialSpectrum: number[], highFreqRatio: number, spectralPeakRatio: number, peakBin: number }}
 */
export function extractSpectralFeatures(rgba, width, height) {
  const { gray, size } = centerCropGrayscale(rgba, width, height, CROP_SIZE);
  const power = fft2Power(gray, size);
  return radialFeatures(power, size);
}

/**
 * Center-crop to a square and convert to normalized grayscale (0..1).
 * @param {Uint8ClampedArray|Uint8Array} rgba RGBA interleaved, length width*height*4
 * @param {number} width
 * @param {number} height
 * @param {number} size output square edge (px)
 * @returns {{ gray: Float32Array, size: number }}
 */
function centerCropGrayscale(rgba, width, height, size) {
  const out = new Float32Array(size * size);
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const half = Math.min(size, Math.min(width, height)) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // nearest-neighbor map from crop region (keeps it simple & deterministic)
      const sx = Math.min(width - 1, Math.max(0, Math.round(cx - half + (x / size) * 2 * half)));
      const sy = Math.min(height - 1, Math.max(0, Math.round(cy - half + (y / size) * 2 * half)));
      const i = (sy * width + sx) * 4;
      // luma (Rec. 601)
      out[y * size + x] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
    }
  }
  return { gray: out, size };
}

/**
 * 2D power spectrum (|FFT|^2) with fft.js: 1D FFT per row then per column.
 * @param {Float32Array} gray grayscale plane (size*size)
 * @param {number} size square edge (px)
 * @returns {Float32Array} power spectrum (size*size)
 */
function fft2Power(gray, size) {
  const f = getFft(size);
  const rowOut = f.createComplexArray();
  const spectrum = new Float32Array(size * size); // store complex interleaved magnitudes
  // row FFTs
  const rows = new Float64Array(size * size * 2); // complex
  const input = f.createComplexArray();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      input[2 * x] = gray[y * size + x];
      input[2 * x + 1] = 0;
    }
    f.transform(rowOut, input);
    for (let x = 0; x < size; x++) {
      rows[2 * (y * size + x)] = rowOut[2 * x];
      rows[2 * (y * size + x) + 1] = rowOut[2 * x + 1];
    }
  }
  // column FFTs
  const colIn = f.createComplexArray();
  const colOut = f.createComplexArray();
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      colIn[2 * y] = rows[2 * (y * size + x)];
      colIn[2 * y + 1] = rows[2 * (y * size + x) + 1];
    }
    f.transform(colOut, colIn);
    for (let y = 0; y < size; y++) {
      const re = colOut[2 * y];
      const im = colOut[2 * y + 1];
      spectrum[y * size + x] = re * re + im * im; // power
    }
  }
  return spectrum;
}

/**
 * Azimuthal-average the power spectrum into log-spaced radial bins + summary stats.
 * @param {Float32Array} power power spectrum (size*size)
 * @param {number} size square edge (px)
 * @returns {{ radialSpectrum: number[], highFreqRatio: number, spectralPeakRatio: number, peakBin: number }}
 */
function radialFeatures(power, size) {
  const center = size / 2;
  const maxR = size / 2;
  const sums = new Float64Array(RADIAL_BINS);
  const counts = new Float64Array(RADIAL_BINS);
  let lowEnergy = 0;
  let highEnergy = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // fft.js does NOT fft-shift: index k holds frequency k for k <= N/2 and k - N for k > N/2.
      // Map array index -> signed frequency so DC lands at radius 0.
      const fx = x <= center ? x : x - size;
      const fy = y <= center ? y : y - size;
      const r = Math.sqrt(fx * fx + fy * fy);
      // Include the Nyquist ring (r == maxR) — high-frequency checkerboard energy lands there.
      if (r < 1 || r > maxR) continue;
      const logR = Math.log(r);
      const logMax = Math.log(maxR);
      const bin = Math.min(RADIAL_BINS - 1, Math.floor((logR / logMax) * RADIAL_BINS));
      const p = power[y * size + x];
      sums[bin] += p;
      counts[bin]++;
      if (r > maxR / 2) highEnergy += p;
      else lowEnergy += p;
    }
  }

  const radialSpectrum = [];
  for (let i = 0; i < RADIAL_BINS; i++) {
    radialSpectrum.push(counts[i] ? Math.log10(1 + sums[i] / counts[i]) : 0);
  }

  const highFreqRatio = lowEnergy + highEnergy > 0 ? highEnergy / (lowEnergy + highEnergy) : 0;

  // Peak detection: strongest non-DC bin (periodic upsampling spikes).
  let peakBin = 0;
  let peakVal = 0;
  for (let i = 1; i < RADIAL_BINS; i++) {
    if (radialSpectrum[i] > peakVal) {
      peakVal = radialSpectrum[i];
      peakBin = i;
    }
  }
  const meanSpec = radialSpectrum.reduce((a, b) => a + b, 0) / RADIAL_BINS;
  const spectralPeakRatio = meanSpec > 0 ? peakVal / meanSpec : 0;

  return { radialSpectrum, highFreqRatio, spectralPeakRatio, peakBin };
}
