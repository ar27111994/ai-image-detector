/**
 * Shared image preprocessing — pure JS, dependency-free.
 *
 * Used verbatim by BOTH the browser extension (after canvas/bitmap decode) and the Node
 * benchmark harness (after sharp decode), so offline benchmark numbers transfer to production.
 *
 * Pipeline matches HF ViTFeatureExtractor semantics with resample=2 (bilinear):
 *   decode -> RGBA -> bilinear resize to (inputSize x inputSize) -> rescale 1/255 ->
 *   normalize (x - mean) / std -> CHW float32 planar tensor.
 */

/** ImageNet normalization means (fallback when a model config does not specify its own). */
export const IMAGENET_MEAN = Object.freeze([0.485, 0.456, 0.406]);
/** ImageNet normalization standard deviations (paired with IMAGENET_MEAN). */
export const IMAGENET_STD = Object.freeze([0.229, 0.224, 0.225]);

/**
 * Bilinear resize of an RGBA buffer. Pure JS for deterministic, engine-independent results.
 * Alpha is ignored (images are flattened onto opaque pixels by the decoder/canvas first).
 *
 * @param {Uint8ClampedArray | Uint8Array} src RGBA interleaved, length srcW*srcH*4
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Uint8ClampedArray} RGBA interleaved, length dstW*dstH*4
 */
export function resizeRgbaBilinear(src, srcW, srcH, dstW, dstH) {
  if (src.length !== srcW * srcH * 4) {
    throw new RangeError(
      `resizeRgbaBilinear: expected ${srcW * srcH * 4} bytes, got ${src.length}`,
    );
  }
  if (srcW === dstW && srcH === dstH) return Uint8ClampedArray.from(src);

  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    // Pixel-center aligned sampling (same convention as PIL/torchvision bilinear).
    const srcY = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.floor(srcY));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = Math.min(1, Math.max(0, srcY - y0));

    for (let x = 0; x < dstW; x++) {
      const srcX = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.floor(srcX));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = Math.min(1, Math.max(0, srcX - x0));

      const i00 = (y0 * srcW + x0) * 4;
      const i01 = (y0 * srcW + x1) * 4;
      const i10 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const di = (y * dstW + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx;
        const bottom = src[i10 + c] * (1 - wx) + src[i11 + c] * wx;
        dst[di + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return dst;
}

/**
 * Convert an RGBA buffer to a normalized CHW float32 tensor.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba RGBA interleaved, length width*height*4
 * @param {number} width
 * @param {number} height
 * @param {object} norm
 * @param {number[]} norm.mean per-channel means (applied after 1/255 rescale)
 * @param {number[]} norm.std  per-channel stds
 * @returns {{ data: Float32Array, dims: [1, 3, number, number] }}
 */
export function rgbaToChwTensor(
  rgba,
  width,
  height,
  { mean = IMAGENET_MEAN, std = IMAGENET_STD } = {},
) {
  const pixels = width * height;
  if (pixels <= 0 || rgba.length !== pixels * 4) {
    throw new RangeError(
      `rgbaToChwTensor: expected ${pixels * 4} bytes for ${width}x${height}, got ${rgba.length}`,
    );
  }
  const data = new Float32Array(3 * pixels);
  const planeG = pixels;
  const planeB = 2 * pixels;
  for (let i = 0; i < pixels; i++) {
    const si = i * 4;
    data[i] = (rgba[si] / 255 - mean[0]) / std[0];
    data[planeG + i] = (rgba[si + 1] / 255 - mean[1]) / std[1];
    data[planeB + i] = (rgba[si + 2] / 255 - mean[2]) / std[2];
  }
  return { data, dims: [1, 3, height, width] };
}

/**
 * Full RGBA -> model-input pipeline.
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {object} spec
 * @param {number} spec.inputSize
 * @param {number[]} [spec.mean]
 * @param {number[]} [spec.std]
 * @returns {{ data: Float32Array, dims: [1, 3, number, number] }}
 */
export function preprocessRgba(rgba, width, height, spec) {
  const size = spec.inputSize;
  const resized = resizeRgbaBilinear(rgba, width, height, size, size);
  return rgbaToChwTensor(resized, size, size, spec);
}
