/**
 * Shared numeric helpers — pure JS, dependency-free.
 */

/**
 * Clamp a number to the inclusive range [0, 1].
 * Non-finite input collapses to the nearest bound via Math.min/Math.max semantics.
 * @param {number} x
 * @returns {number} value in [0, 1]
 */
export function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/**
 * Softmax over a 2-class logit pair, returning the probability of `aiIndex`.
 * Numerically stable (max-subtracted before exp).
 *
 * @param {Float32Array | number[]} logits
 * @param {number} aiIndex index of the "AI-generated" class
 * @returns {number} probability in (0, 1)
 */
export function softmaxProbability(logits, aiIndex) {
  if (logits.length < 2) throw new RangeError('expected at least 2 logits');
  const a = logits[aiIndex];
  const b = logits[aiIndex === 0 ? 1 : 0];
  const m = Math.max(a, b);
  const ea = Math.exp(a - m);
  const eb = Math.exp(b - m);
  return ea / (ea + eb);
}
