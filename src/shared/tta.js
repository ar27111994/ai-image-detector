/**
 * Test-time augmentation (TTA) view selection + logit aggregation — shared, pure logic used
 * identically by the production inference engine (createImageBitmap path) and the offline
 * benchmark (sharp path), so the measured benchmark accuracy reflects exactly what ships.
 *
 * Strategy: always score the full frame; when the image is large enough that downscaling to the
 * model input would wash out high-frequency generator artifacts, also score a center + 4-corner
 * 50% crop grid, then average the raw LOGITS (pre-softmax) across views.
 */

/**
 * Compute the set of source-rect views to score for an image of `width` x `height` given a
 * square model input of `inputSize`.
 *
 * @param {number} width  source image width (px)
 * @param {number} height source image height (px)
 * @param {number} inputSize model input edge (px)
 * @returns {Array<{ sx: number, sy: number, sw: number, sh: number }>} source rects
 */
export function computeViewRects(width, height, inputSize, { enableCropGrid = false } = {}) {
  const full = { sx: 0, sy: 0, sw: width, sh: height };
  // Measured result (471-image internal benchmark, SwinV2): the 50% crop grid REDUCES balanced
  // accuracy (TTA 79.6% vs single-view 84.5%) because crops discard the global generation
  // artifacts the model relies on. Crop-grid TTA is therefore OFF by default; it can be
  // re-enabled for architectures that benefit (e.g., a patch-token model like DINOv2+PatchHead).
  if (!enableCropGrid) return [full];

  const minDim = Math.min(width, height);
  if (minDim < inputSize * 2) return [full];

  const crop = Math.floor(minDim * 0.5); // 50% crops
  const halfW = Math.floor((crop * (width / minDim)) / 2) * 2;
  const halfH = Math.floor((crop * (height / minDim)) / 2) * 2;
  return [
    full,
    { sx: 0, sy: 0, sw: halfW, sh: halfH }, // top-left
    { sx: width - halfW, sy: 0, sw: halfW, sh: halfH }, // top-right
    { sx: 0, sy: height - halfH, sw: halfW, sh: halfH }, // bottom-left
    { sx: width - halfW, sy: height - halfH, sw: halfW, sh: halfH }, // bottom-right
    {
      sx: Math.floor((width - halfW) / 2),
      sy: Math.floor((height - halfH) / 2),
      sw: halfW,
      sh: halfH,
    }, // center
  ];
}

/**
 * Average raw logits across views (element-wise mean), then the caller maps to a probability
 * once via the model's output semantics. Averaging pre-softmax logits preserves the
 * discriminative signal better than averaging calibrated probabilities.
 *
 * @param {number[][]} viewsLogits one logit vector per view
 * @returns {number[]} mean logit vector
 */
export function meanLogits(viewsLogits) {
  if (!viewsLogits.length) throw new RangeError('meanLogits: no views');
  const nViews = viewsLogits.length;
  const nClasses = viewsLogits[0].length;
  const out = new Array(nClasses).fill(0);
  for (const logits of viewsLogits) {
    if (logits.length !== nClasses) throw new RangeError('meanLogits: inconsistent class count');
    for (let c = 0; c < nClasses; c++) out[c] += logits[c] / nViews;
  }
  return out;
}
